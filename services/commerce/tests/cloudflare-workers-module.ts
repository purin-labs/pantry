export class DurableObject<Bindings> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Bindings;

  constructor(ctx: DurableObjectState, env: Bindings) {
    this.ctx = ctx;
    this.env = env;
  }
}
