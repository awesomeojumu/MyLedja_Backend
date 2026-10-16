export type AuthFailureStatus =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "unverified"
  | "rate_limited";

export class AuthFailure extends Error {
  constructor(
    readonly status: AuthFailureStatus,
    message: string,
  ) {
    super(message);
    this.name = "AuthFailure";
  }
}
