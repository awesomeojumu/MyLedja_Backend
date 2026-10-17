export interface Institution {
  id: string;
  name: string;
  country: "NG";
}

export const INSTITUTIONS: readonly Institution[] = [
  { id: "gtbank", name: "Guaranty Trust Bank", country: "NG" },
  { id: "access", name: "Access Bank", country: "NG" },
  { id: "zenith", name: "Zenith Bank", country: "NG" },
  { id: "uba", name: "United Bank for Africa", country: "NG" },
  { id: "firstbank", name: "First Bank of Nigeria", country: "NG" },
  { id: "kuda", name: "Kuda", country: "NG" },
  { id: "opay", name: "Opay", country: "NG" },
];

export function institutionById(id: string): Institution | undefined {
  return INSTITUTIONS.find((row) => row.id === id);
}
