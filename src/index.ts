import type { Adapter, Options, StartStop } from './types.ts'
import { Notifier } from './notifier.ts'
import { Poller } from './poller.ts'
import { Transfer } from './transfer.ts'
import { FSM } from './fsm.ts'
import { Logical } from './logical.ts'
import { P, match } from 'ts-pattern'
import { Pg } from './pg.ts'
import { Responder } from './responder.ts'
import { diDep, diExists, diHas } from 'ts-fp-di'

export class PgTrxOutbox implements StartStop {
  private pg: Pg
  private transfer: Transfer
  private adapter: Adapter
  private responder: Responder
  private poller?: Poller
  private notifier?: Notifier
  private logical?: Logical

  constructor(options: Options) {
    const opts: Options = {
      ...options,
      outboxOptions: {
        onError(err: Error) {
          console.error(`Error happens on pg-trx-outbox: ${err.stack ?? err.message ?? err}`)
        },
        ...options.outboxOptions,
      },
    }
    this.adapter = opts.adapter
    this.pg = new Pg(opts)
    this.transfer = new Transfer(opts, this.pg, this.adapter)
    this.responder = new Responder(opts, this.pg)
    const fsm = new FSM(opts, this.transfer)
    match(opts.outboxOptions?.mode)
      .with(P.union('short-polling', void 0), () => (this.poller = new Poller(opts, fsm)))
      .with('notify', () => {
        this.poller = new Poller(opts, fsm)
        this.notifier = new Notifier(opts, fsm)
      })
      .with('logical', () => (this.logical = new Logical(opts, this.transfer)))
      .exhaustive()
  }

  async start() {
    await this.adapter.start()
    await this.pg.start()
    await this.responder.start()
    await this.poller?.start()
    await this.notifier?.start()
    await this.logical?.start()
  }

  async stop() {
    await this.logical?.stop()
    await this.notifier?.stop()
    await this.poller?.stop()
    await this.responder.stop()
    await this.pg.stop()
    await this.adapter.stop()
  }

  async waitResponse<T>(id: string, key?: string) {
    return this.responder.waitResponse(id, key) as T
  }

  contextId() {
    return diExists() && diHas('pg_trx_outbox_context_id') ? diDep<number>('pg_trx_outbox_context_id') : null
  }
}
