/** Own asynchronous UI publication across events, routes and mount lifetime. */
export class ActivityRequestScope {
  constructor(
    private readonly ownsForeground: () => boolean = () => true,
    private readonly readRoute: () => string | undefined = () => undefined
  ) {}

  private generation = 0;
  private mounted = true;
  private route?: string;

  invalidate(): void {
    this.generation++;
  }
  open(): void {
    this.mounted = true;
  }
  close(): void {
    this.mounted = false;
    this.invalidate();
  }

  /** An intentional close may precede completion; opening another route supersedes it. */
  updateRoute(route: string | undefined): void {
    if (route && this.route !== route) this.invalidate();
    this.route = route;
  }

  /** Own the loading route before React commits it, without cancelling our read. */
  claimRoute(route: string): () => boolean {
    this.invalidate();
    this.route = route;
    const previousRoute = this.readRoute();
    const generation = this.generation;
    return () => {
      const currentRoute = this.readRoute();
      return (
        this.mounted &&
        this.ownsForeground() &&
        generation === this.generation &&
        (!currentRoute || currentRoute === route || currentRoute === previousRoute)
      );
    };
  }

  capture(): () => boolean {
    const generation = this.generation;
    const route = this.readRoute();
    return () =>
      this.mounted &&
      this.ownsForeground() &&
      generation === this.generation &&
      (!this.readRoute() || this.readRoute() === route);
  }
}
