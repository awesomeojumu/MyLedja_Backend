export class LedgerFailure extends Error {
  constructor(
    readonly status: "bad_request" | "not_found" | "forbidden" | "conflict" | "reused" | "unprocessable",
    message: string,
  ) {
    super(message);
    this.name = "LedgerFailure";
  }
}
