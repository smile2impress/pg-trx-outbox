import { Admin, Consumer, EachMessagePayload, Kafka as KafkaJS, RecordMetadata } from 'kafkajs'
import { afterEach, beforeEach, test } from 'node:test'
import { Client } from 'pg'
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka'
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { PgTrxOutbox } from '../src/index.ts'
import { setTimeout } from 'timers/promises'
import assert from 'assert'
import { Kafka } from '../src/adapters/kafka.ts'

let kafkaDocker: StartedKafkaContainer
let pgDocker: StartedPostgreSqlContainer
let pg: Client
let kafkaAdmin: Admin
let kafkaConsumer: Consumer
let pgKafkaTrxOutbox: PgTrxOutbox
let messages: EachMessagePayload[] = []

beforeEach(async () => {
  kafkaDocker = await new KafkaContainer().withExposedPorts(9093).withReuse().start()
  pgDocker = await new PostgreSqlContainer()
    .withReuse()
    .withCommand(['-c', 'fsync=off', '-c', 'wal_level=logical'])
    .start()

  pg = new Client({
    host: pgDocker.getHost(),
    port: pgDocker.getPort(),
    user: pgDocker.getUsername(),
    password: pgDocker.getPassword(),
    database: pgDocker.getDatabase(),
    application_name: 'pg_trx_outbox_admin',
  })
  await pg.connect()
  await pg.query('DROP TABLE IF EXISTS pg_trx_outbox')
  await pg.query(`
    CREATE TABLE IF NOT EXISTS pg_trx_outbox (
      id bigserial NOT NULL,
      processed bool NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      since_at timestamptz NULL,
      topic text NOT NULL,
      "key" text NULL,
      value jsonb NULL,
      "partition" int2 NULL,
      "timestamp" int8 NULL,
      headers jsonb NULL,
      response jsonb NULL,
      error text NULL,
      meta jsonb NULL,
      context_id double precision NOT NULL DEFAULT random(),
      attempts smallint NOT NULL DEFAULT 0,
      CONSTRAINT pg_trx_outbox_pk PRIMARY KEY (id)
    );
  `)
  await pg.query(`
    CREATE OR REPLACE FUNCTION pg_trx_outbox() RETURNS trigger AS $trigger$
      BEGIN
        PERFORM pg_notify('pg_trx_outbox', '{}');
        RETURN NEW;
      END;
    $trigger$ LANGUAGE plpgsql;
  `)
  await pg.query(`DROP TRIGGER IF EXISTS pg_trx_outbox ON pg_trx_outbox;`)
  await pg.query(`
    CREATE TRIGGER pg_trx_outbox AFTER INSERT ON pg_trx_outbox
    EXECUTE PROCEDURE pg_trx_outbox();
  `)
  await pg.query(`
    DROP PUBLICATION IF EXISTS pg_trx_outbox
  `)
  try {
    await pg.query(`
      SELECT pg_drop_replication_slot('pg_trx_outbox')
    `)
  } catch (e) {}

  const kafka = new KafkaJS({
    clientId: 'pg_trx_outbox_admin',
    brokers: [`${kafkaDocker.getHost()}:${kafkaDocker.getMappedPort(9093)}`],
  })
  kafkaAdmin = kafka.admin()
  await kafkaAdmin.connect()
  const { topics } = await kafkaAdmin.fetchTopicMetadata()
  if (topics.find(t => t.name === 'pg.kafka.trx.outbox')) {
    await kafkaAdmin.deleteTopics({ topics: ['pg.kafka.trx.outbox'] })
  }
  await kafkaAdmin.createTopics({ topics: [{ topic: 'pg.kafka.trx.outbox' }] })

  kafkaConsumer = kafka.consumer({ groupId: 'test' })
  await kafkaConsumer.connect()
  await kafkaConsumer.subscribe({ topic: 'pg.kafka.trx.outbox' })
  kafkaConsumer.run({
    eachMessage: async payload => (messages.push(payload), void 0),
  })
  await setTimeout(1000) // subscriber ready
})

afterEach(async () => {
  await pgKafkaTrxOutbox.stop()
  await pg.end()
  await kafkaAdmin.disconnect()
  await kafkaConsumer.disconnect()
  messages = []
})

test('short polling', async () => {
  pgKafkaTrxOutbox = new PgTrxOutbox({
    adapter: new Kafka({
      kafkaOptions: {
        brokers: [`${kafkaDocker.getHost()}:${kafkaDocker.getMappedPort(9093)}`],
      },
    }),
    pgOptions: {
      host: pgDocker.getHost(),
      port: pgDocker.getPort(),
      user: pgDocker.getUsername(),
      password: pgDocker.getPassword(),
      database: pgDocker.getDatabase(),
    },
    outboxOptions: {
      pollInterval: 300,
    },
  })
  await pgKafkaTrxOutbox.start()
  await pg.query(`
    INSERT INTO pg_trx_outbox
      (topic, "key", value)
      VALUES ('pg.kafka.trx.outbox', 'testKey', '{"test": true}');
    `)
  await setTimeout(1000)

  const processedRow: {
    processed: boolean
    created_at: Date
    updated_at: Date
    response: RecordMetadata
  } = await pg.query(`select * from pg_trx_outbox`).then(resp => resp.rows[0])
  assert.strictEqual(processedRow.processed, true)
  assert.strictEqual(processedRow.updated_at > processedRow.created_at, true)
  assert.strictEqual(processedRow.response.partition, 0)
  assert.strictEqual(processedRow.response.topicName, 'pg.kafka.trx.outbox')

  assert.strictEqual(messages.length, 1)
  assert.strictEqual(messages[0]?.topic, 'pg.kafka.trx.outbox')
  assert.strictEqual(messages[0]?.partition, 0)
  assert.strictEqual(messages[0]?.message.key?.toString(), 'testKey')
  assert.strictEqual(messages[0]?.message.value?.toString(), '{"test":true}')
  assert.strictEqual(messages[0]?.message.offset, '0')
  assert.strictEqual(Date.now() - Number(messages[0]?.message.timestamp) < 1000, true)
})

test('limit', async () => {
  pgKafkaTrxOutbox = new PgTrxOutbox({
    adapter: new Kafka({
      kafkaOptions: {
        brokers: [`${kafkaDocker.getHost()}:${kafkaDocker.getMappedPort(9093)}`],
      },
    }),
    pgOptions: {
      host: pgDocker.getHost(),
      port: pgDocker.getPort(),
      user: pgDocker.getUsername(),
      password: pgDocker.getPassword(),
      database: pgDocker.getDatabase(),
    },
    outboxOptions: {
      pollInterval: 300,
      limit: 1,
    },
  })
  await pg.query(`
    INSERT INTO pg_trx_outbox
      (topic, "key", value)
      VALUES ('pg.kafka.trx.outbox', 'testKey', '{"test": true, "n": 1}'),
        ('pg.kafka.trx.outbox', 'testKey', '{"test": true, "n": 2}');
    `)
  await pgKafkaTrxOutbox.start()
  await setTimeout(350)

  const processedRow: {
    processed: boolean
    created_at: Date
    updated_at: Date
    response: RecordMetadata
  }[] = await pg.query(`select * from pg_trx_outbox order by id`).then(resp => resp.rows)
  assert.strictEqual(processedRow[0]?.processed, true)
  assert.strictEqual(processedRow[0]?.updated_at > processedRow[0]?.created_at, true)
  assert.strictEqual(processedRow[0]?.response.partition, 0)
  assert.strictEqual(processedRow[0]?.response.topicName, 'pg.kafka.trx.outbox')

  assert.strictEqual(processedRow[1]?.processed, false)
  assert.strictEqual(processedRow[1]?.updated_at.toISOString(), processedRow[1]?.created_at.toISOString())
  assert.strictEqual(processedRow[1]?.response, null)

  assert.strictEqual(messages.length, 1)
  assert.strictEqual(messages[0]?.message.value?.toString(), '{"n":1,"test":true}')
})

test('notify', async () => {
  pgKafkaTrxOutbox = new PgTrxOutbox({
    adapter: new Kafka({
      kafkaOptions: {
        brokers: [`${kafkaDocker.getHost()}:${kafkaDocker.getMappedPort(9093)}`],
      },
    }),
    pgOptions: {
      host: pgDocker.getHost(),
      port: pgDocker.getPort(),
      user: pgDocker.getUsername(),
      password: pgDocker.getPassword(),
      database: pgDocker.getDatabase(),
    },
    outboxOptions: {
      mode: 'notify',
    },
  })
  await pgKafkaTrxOutbox.start()
  await pg.query(`
    INSERT INTO pg_trx_outbox
      (topic, "key", value)
      VALUES ('pg.kafka.trx.outbox', 'testKey', '{"test": true}');
  `)
  await setTimeout(100)

  const processedRow: {
    processed: boolean
    created_at: Date
    updated_at: Date
    response: RecordMetadata
  }[] = await pg.query(`select * from pg_trx_outbox order by id`).then(resp => resp.rows)
  assert.strictEqual(processedRow[0]?.processed, true)
  assert.strictEqual(processedRow[0]?.updated_at > processedRow[0]?.created_at, true)
  assert.strictEqual(processedRow[0]?.response.partition, 0)
  assert.strictEqual(processedRow[0]?.response.topicName, 'pg.kafka.trx.outbox')

  assert.strictEqual(messages.length, 1)
  assert.strictEqual(messages[0]?.message.value?.toString(), '{"test":true}')
})

test('logical', async () => {
  await pg.query(`
    SELECT pg_create_logical_replication_slot(
      'pg_trx_outbox',
      'pgoutput'
    )
  `)
  await pg.query(`
    CREATE PUBLICATION pg_trx_outbox FOR TABLE pg_trx_outbox WITH (publish = 'insert');
  `)
  pgKafkaTrxOutbox = new PgTrxOutbox({
    adapter: new Kafka({
      kafkaOptions: {
        brokers: [`${kafkaDocker.getHost()}:${kafkaDocker.getMappedPort(9093)}`],
      },
    }),
    pgOptions: {
      host: pgDocker.getHost(),
      port: pgDocker.getPort(),
      user: pgDocker.getUsername(),
      password: pgDocker.getPassword(),
      database: pgDocker.getDatabase(),
    },
    outboxOptions: {
      mode: 'logical',
    },
  })
  await pg.query(`
    INSERT INTO pg_trx_outbox
      (topic, "key", value)
      VALUES ('pg.kafka.trx.outbox', 'testKey', '{"test": true}');
  `)
  await pgKafkaTrxOutbox.start()
  await setTimeout(1000)

  const processedRow: {
    processed: boolean
    created_at: Date
    updated_at: Date
    response: RecordMetadata
  }[] = await pg.query(`select * from pg_trx_outbox order by id`).then(resp => resp.rows)

  assert.strictEqual(processedRow[0]?.processed, true)
  assert.strictEqual(processedRow[0]?.updated_at > processedRow[0]?.created_at, true)
  assert.strictEqual(processedRow[0]?.response.partition, 0)
  assert.strictEqual(processedRow[0]?.response.topicName, 'pg.kafka.trx.outbox')

  assert.strictEqual(messages.length, 1)
  assert.strictEqual(messages[0]?.message.value?.toString(), '{"test":true}')
})
