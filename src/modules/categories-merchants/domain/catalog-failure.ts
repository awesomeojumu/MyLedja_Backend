export class CatalogFailure extends Error {
  constructor(
    readonly status: "bad_request" | "not_found" | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "CatalogFailure";
  }
}
