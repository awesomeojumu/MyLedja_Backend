export class MfaRequired extends Error {
  constructor(readonly challengeId: string) {
    super("mfa required");
    this.name = "MfaRequired";
  }
}
