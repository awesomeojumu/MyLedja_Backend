import { readSetupPatch } from "@/modules/workspaces/application/read-setup-patch";

describe("008 setup patch", () => {
  it("keeps locale, timezone, week start, and reminder toggles", () => {
    expect(
      readSetupPatch({
        defaultCurrency: "NGN",
        locale: "en-NG",
        timezone: "Africa/Lagos",
        weekStartsOn: "sunday",
        reminders: { bills: false, budget: true, summary: true },
        setupProgress: { currency: true },
      }),
    ).toEqual({
      defaultCurrency: "NGN",
      locale: "en-NG",
      timezone: "Africa/Lagos",
      weekStartsOn: "sunday",
      reminders: { bills: false, budget: true, summary: true },
      setupProgress: { currency: true },
    });
  });

  it("drops a reminder object that is not three booleans", () => {
    expect(readSetupPatch({ reminders: { bills: "yes", budget: true, summary: false } }).reminders).toBeUndefined();
  });
});
