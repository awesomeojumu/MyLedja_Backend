/** Quote a CSV cell and neutralize a formula prefix, including a leading tab or carriage return. */
export function csvCell(value: string): string {
  const first = value.charAt(0);
  const raw = "=+-@\t\r".includes(first) ? `'${value}` : value;
  return `"${raw.replace(/"/g, '""')}"`;
}
