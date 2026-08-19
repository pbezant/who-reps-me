// USPS state abbreviation -> 2-digit Census FIPS code (zero-padded string). This is a stable
// ANSI/FIPS standard, not something that changes across data vintages — unlike file paths/URLs,
// which do (see fetch-census-data.js's own header comment) — so it's safe to hardcode here.
//
// Cross-checked against a live directory listing of the Census Gazetteer's per-state files
// (https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/): the FIPS numbers
// below produced exactly the same set of "_NN" filename suffixes actually present (gaps at 03,
// 07, 14, 43, 52 — codes retired or never assigned — then a jump to 72 for Puerto Rico).
export const STATE_FIPS = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09", DE: "10",
  DC: "11", FL: "12", GA: "13", HI: "15", ID: "16", IL: "17", IN: "18", IA: "19",
  KS: "20", KY: "21", LA: "22", ME: "23", MD: "24", MA: "25", MI: "26", MN: "27",
  MS: "28", MO: "29", MT: "30", NE: "31", NV: "32", NH: "33", NJ: "34", NM: "35",
  NY: "36", NC: "37", ND: "38", OH: "39", OK: "40", OR: "41", PA: "42", RI: "44",
  SC: "45", SD: "46", TN: "47", TX: "48", UT: "49", VT: "50", VA: "51", WA: "53",
  WV: "54", WI: "55", WY: "56", PR: "72",
};

export function stateFips(usps) {
  return STATE_FIPS[(usps || "").toUpperCase()] || null;
}
