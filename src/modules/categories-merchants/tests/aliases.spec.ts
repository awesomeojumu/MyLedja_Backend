import { resolveMerchant } from "@/modules/categories-merchants/domain/aliases";

describe("merchant aliases", () => {
  const merchants = [
    { name: "Shoprite", aliases: ["PAYSTACK*SHOPRITE", "PAYSTACK"] },
    { name: "Uber", aliases: ["FLW-UBER"] },
  ];

  it("prefers the longest alias", () => {
    expect(resolveMerchant("PAYSTACK*SHOPRITE IKOYI", merchants)?.name).toBe("Shoprite");
  });

  it("leaves unknown processor strings unmatched", () => {
    expect(resolveMerchant("RANDOM POS 99", merchants)).toBeUndefined();
  });
});
