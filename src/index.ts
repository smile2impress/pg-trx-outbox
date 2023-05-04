import type { Adapter, Options, StartStop } from './types'
import { Notifier } from './notifier'
import { Poller } from './poller'
import { Transfer } from './transfer'
import { FSM } from './fsm'
import { Logical } from './logical'
import { P, match } from 'ts-pattern'
import { Pg } from './pg'

export class PgTrxOutbox implements StartStop {
  private pg: Pg
  private transfer: Transfer
  private adapter: Adapter
  private poller?: Poller
  private notifier?: Notifier
  private logical?: Logical

  constructor(options: Options) {
    this.adapter = options.adapter
    this.pg = new Pg(options)
    this.transfer = new Transfer(options, this.pg, this.adapter)
    const fsm = new FSM(options, this.transfer)
    match(options.outboxOptions?.mode)
      .with(P.union('short-polling', void 0), () => (this.poller = new Poller(options, fsm)))
      .with('notify', () => {
        this.poller = new Poller(options, fsm)
        this.notifier = new Notifier(options, fsm)
      })
      .with('logical', () => (this.logical = new Logical(options, this.transfer)))
      .exhaustive()
  }

  async start() {
    await this.adapter.start()
    await this.pg.start()
    await this.poller?.start()
    await this.notifier?.start()
    await this.logical?.start()
  }

  async stop() {
    await this.logical?.stop()
    await this.notifier?.stop()
    await this.poller?.stop()
    await this.pg.stop()
    await this.adapter.stop()
  }
}
