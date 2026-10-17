export class AccountFailure extends Error {
  constructor(
    readonly status: "bad_request" | "not_found" | "forbidden" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "AccountFailure";
  }
}
