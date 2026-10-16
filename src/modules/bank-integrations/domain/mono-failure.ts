export class MonoFailure extends Error {
  constructor(
    readonly status: "bad_request" | "unauthorized" | "not_found" | "misconfigured" | "upstream",
    message: string,
  ) {
    super(message);
    this.name = "MonoFailure";
  }
}
