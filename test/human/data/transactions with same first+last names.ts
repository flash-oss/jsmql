// The documents for the test "transactions with same first+last names" in test/human/human.test.ts.
//
// The default export is the virtual accounts (VANs). `transactions` and `kycs` are the two
// other collections. A KYC document has the `_id` of its VAN, and a transaction names its
// VAN in `vanId`.
//
// Each document also has fields that the query does not read, as a real document has.
//
// The first group has the full schema with correct values. The second group breaks the
// schema, one fault per document. A comment on each document names what it tests.

import { ObjectId } from "bson";

const FIN = new ObjectId("612309871234098712340987");
const OTHER_FIN = new ObjectId("6123098712340987123409ff");

// Real ObjectIds: the VANs were created in 2025, the transactions in 2026.
const VAN_IDS: Record<number, string> = {
  1: "67a1b43b19b4568497de0822",
  2: "67b2893383deaef3d03fd414",
  3: "67cfae519a8e6da5ec21c05d",
  4: "67e0aa758b62fd57f823e37a",
  5: "67fa978b1a57c8f72bae2c30",
  6: "680b96779c5de8234af23b30",
  7: "68213efd6b9fdeac435c73a5",
  10: "682c54caa02f462b012ba9cb",
  11: "683988d9e3f05214fd92e731",
  12: "684de0fd6246fea0ec9e5a15",
  13: "6866d822f55c5a3ac4aa305b",
  14: "687b91aedbfe50ffbd74efb7",
  15: "6893a8f39b3a50e5e7d35edb",
  16: "68a5801121d12a68582cdabb",
  17: "68b2f9d36bb6313b558c438a",
  18: "68c863cfb0036c105f32cc0a",
  19: "68d90794eb28c62a2cb29822",
  20: "68ef19017ee72ecbd954fb8a",
  21: "69091234ec56ab8de65d2603",
  22: "691cdabd92f95a0468475f7d",
  23: "692817f204a2999b0374bda1",
  99: "693a502ebe798c37f8bd4a21",
};
const TX_IDS: Record<number, string> = {
  1: "695cbb07afb6f502bc00d192",
  2: "6960b746f8b86245167c87e3",
  3: "6966ebdde33009d3f6e038ff",
  4: "69691b7635e42d93ba6f48c6",
  5: "696f57f4b32be86c75b9456b",
  6: "6971fdcfe5c474c83dd3c11c",
  7: "6977f92a8d077641e7166660",
  8: "69794481a8b79419c51c8dad",
  9: "697e51ebed1d6ada4ed1a527",
  10: "69805accae8ace860e7366ce",
  11: "698491bbf576896552d218f3",
  20: "698baeba69007786bc95c91f",
  21: "6990a5d15eb89c2e45c5fe0a",
  22: "6994f4d46c16e8b795501e40",
  23: "6998f53cbe04a537521032e3",
  24: "699978047678b81c53542f47",
  25: "699dab627b62415d1fd4b88e",
  26: "69a58b4b6fe0c752f1e9d90d",
  27: "69a79fc230ba6d0f179b0aff",
  28: "69aa551139090613e57316ca",
  40: "69b00ff349f21a402e40fead",
  41: "69b5763702e56f500d7c7b4e",
  42: "69b76c3762ef48738b0ee088",
  43: "69be5ce0bb86a6485db83f33",
  44: "69c0495091e4da1ca51d8568",
  45: "69c2973285178c5adb850067",
  46: "69c71e77624190e782bc9649",
  47: "69cd5fa15c8d5e1291f8ffda",
  48: "69d14e004022a499e67f1efa",
  49: "69d608d8cf99ced357c38fd5",
  50: "69d799583825d93bf7569310",
  51: "69dc7365b12f56b6a5b579cf",
  52: "69e216c9b44eadbdf6f8a99a",
  53: "69e461dcf7217297df82b878",
  54: "69e938df69d613254716974d",
};

/** The `_id` of VAN number `n`, and of its KYC document. */
const vanId = (n: number) => new ObjectId(VAN_IDS[n]);
/** The `_id` of transaction number `n`. */
const txId = (n: number) => new ObjectId(TX_IDS[n]);

/** An active virtual account of the bank `FIN`. */
const van = (n: number, firstName: unknown, lastName: unknown = firstName, over: Record<string, unknown> = {}) => ({
  _id: vanId(n),
  status: "active",
  finInstnId: FIN,
  virtual: true,
  firstName,
  lastName,
  accountNumber: String(10_000_000 + n * 7919),
  bsb: "802-919",
  currency: "AUD",
  label: `Savings ${n}`,
  createdAt: vanId(n).getTimestamp(),
  ...over,
});

/** The fields of a KYC document that the query does not read. */
const kycExtra = (n: number) => ({
  dateOfBirth: new Date(Date.UTC(1960 + n, n % 12, n)),
  nationality: n % 2 === 0 ? "ID" : "AU",
  address: { line1: `${n} Jalan Merdeka`, city: "Denpasar", postcode: "80111", country: "ID" },
  verification: { status: "VERIFIED", provider: "greenid", checkedAt: vanId(n).getTimestamp() },
  createdAt: vanId(n).getTimestamp(),
});

/** The KYC names of VAN number `n`. `nameDetails` holds more fields than the three names. */
const kyc = (n: number, firstName: unknown, middleName: unknown, lastName: unknown) => ({
  _id: vanId(n),
  nameDetails: {
    title: n % 2 === 0 ? "Mr" : "Ms",
    firstName,
    middleName,
    lastName,
    fullName: [firstName, middleName, lastName].filter((x) => typeof x === "string" && x !== "").join(" "),
    nameOnId: true,
    verifiedAt: vanId(n).getTimestamp(),
  },
  ...kycExtra(n),
});

/** A confirmed inbound payment to VAN number `van`, from a bank account with the name `accountName`. */
const tx = (n: number, van: number, accountName: unknown, over: Record<string, unknown> = {}) => ({
  _id: txId(n),
  finInstnId: FIN,
  vanId: vanId(van),
  status: "CONFIRMED",
  direction: "INBOUND",
  amount: 100 + n,
  currency: "AUD",
  reference: `DEP-${String(n).padStart(4, "0")}`,
  sender: { accountName, bsb: "062-000", accountNumber: String(20_000_000 + n * 104_729), bankName: "CBA" },
  createdAt: txId(n).getTimestamp(),
  updatedAt: new Date(txId(n).getTimestamp().getTime() + 60_000),
  ...over,
});

export default [
  // ── the full schema, correct values ──────────────────────────────────────────

  // A person with one name. The KYC repeats the name.
  van(1, "Sukarno"),
  // A person with three names. The VAN has the first name twice.
  van(2, "Wei"),
  // The KYC names are lower case.
  van(3, "Maria"),

  // ── VANs that the first filter drops ─────────────────────────────────────────

  // Not active.
  van(4, "Budi", "Budi", { status: "closed" }),
  // Not virtual.
  van(5, "Dewi", "Dewi", { virtual: false }),
  // Another bank.
  van(6, "Agus", "Agus", { finInstnId: OTHER_FIN }),
  // The first and last names are different.
  van(7, "John", "Smith"),

  // ── a broken schema, one fault per document ──────────────────────────────────

  // An empty document.
  {},
  // No `status`.
  (({ status, ...rest }) => rest)(van(10, "Rina")),
  // `status` is upper case.
  van(11, "Rina", "Rina", { status: "ACTIVE" }),
  // `virtual` is a string.
  van(12, "Rina", "Rina", { virtual: "true" }),
  // `virtual` is a number.
  van(13, "Rina", "Rina", { virtual: 1 }),
  // `finInstnId` is the hex string, not an ObjectId.
  van(14, "Rina", "Rina", { finInstnId: "612309871234098712340987" }),
  // The names differ by case only.
  van(15, "Ana", "ana"),
  // The first name has a trailing space.
  van(16, "Ana ", "Ana"),
  // Both names are missing: a missing field equals a missing field, so the filter keeps it.
  (({ firstName, lastName, ...rest }) => rest)(van(17, "")),
  // Both names are null: the filter keeps it.
  van(18, null),
  // Both names are empty strings: the filter keeps it.
  van(19, ""),
  // A VAN with no KYC document.
  van(20, "Joko"),
  // A VAN with a null `nameDetails` in its KYC.
  van(21, "Putu"),
  // A VAN with a null first name in its KYC.
  van(22, "Made"),
  // A VAN whose KYC has the `_id` as a hex string, so the KYC does not match.
  van(23, "Ketut"),
];

export const kycs = [
  kyc(1, "Sukarno", null, "Sukarno"),
  kyc(2, "Wei", "Ming", "Zhang"),
  kyc(3, "maria", "", "maria"),
  kyc(4, "Budi", null, "Budi"),
  kyc(5, "Dewi", null, "Dewi"),
  kyc(6, "Agus", null, "Agus"),
  kyc(7, "John", null, "Smith"),
  kyc(17, "Nyoman", null, "Nyoman"),
  kyc(18, "Wayan", null, "Wayan"),
  kyc(19, "Kadek", null, "Kadek"),
  // No KYC for VAN 20.
  { _id: vanId(21), nameDetails: null, ...kycExtra(21) },
  kyc(22, null, null, "Made"),
  { ...kyc(23, "Ketut", null, "Ketut"), _id: String(vanId(23)) },
];

export const transactions = [
  // ── the full schema, correct values ──────────────────────────────────────────

  // VAN 1: the bank name is the same as the KYC name.
  tx(1, 1, "SUKARNO SUKARNO"),
  // VAN 1: the bank shows one name only.
  tx(2, 1, "SUKARNO"),
  // VAN 1: a bank shows a single name with a leading "- ".
  tx(3, 1, "- SUKARNO"),
  // VAN 1: a bank shows a single name with a trailing " -".
  tx(4, 1, "SUKARNO -"),
  // VAN 1: no space after the dash, so it is not a single-name account.
  tx(5, 1, "-SUKARNO"),
  // VAN 2: the bank name is the same as the KYC first and last name.
  tx(6, 2, "WEI ZHANG"),
  // VAN 2: the family name comes first.
  tx(7, 2, "ZHANG WEI"),
  // VAN 2: the bank name has the middle name.
  tx(8, 2, "WEI MING ZHANG"),
  // VAN 2: the bank name is lower case.
  tx(9, 2, "wei zhang"),
  // VAN 3: the lower-case KYC names become upper case, so this is the same name.
  tx(10, 3, "MARIA MARIA"),
  // VAN 3: two spaces between the names.
  tx(11, 3, "MARIA  MARIA"),

  // ── transactions that the lookup drops ───────────────────────────────────────

  // Outbound.
  tx(20, 1, "SUKARNO", { direction: "OUTBOUND" }),
  // Not confirmed.
  tx(21, 1, "SUKARNO", { status: "PENDING" }),
  // Another bank.
  tx(22, 1, "SUKARNO", { finInstnId: OTHER_FIN }),
  // To a VAN that does not exist.
  tx(23, 99, "SUKARNO"),
  // To each VAN that the first filter drops.
  tx(24, 4, "BUDI"),
  tx(25, 5, "DEWI"),
  tx(26, 6, "AGUS"),
  tx(27, 7, "JOHN"),
  tx(28, 11, "RINA"),

  // ── a broken schema, one fault per document ──────────────────────────────────

  // `vanId` is the hex string, not an ObjectId.
  tx(40, 1, "SUKARNO", { vanId: String(vanId(1)) }),
  // `status` is lower case.
  tx(41, 1, "SUKARNO", { status: "confirmed" }),
  // No `direction`.
  (({ direction, ...rest }) => rest)(tx(42, 1, "SUKARNO")),
  // No `sender`.
  (({ sender, ...rest }) => rest)(tx(43, 1, "")),
  // `sender.accountName` is null.
  tx(44, 1, null),
  // `sender.accountName` is a number.
  tx(45, 1, 42),
  // `sender.accountName` has a trailing space.
  tx(46, 1, "SUKARNO SUKARNO "),
  // `sender.accountName` is exactly "- ".
  tx(47, 1, "- "),
  // VAN 17 has no names.
  tx(48, 17, "NYOMAN"),
  // VAN 18 has null names.
  tx(49, 18, "WAYAN"),
  // VAN 19 has empty names.
  tx(50, 19, "KADEK"),
  // VAN 20 has no KYC.
  tx(51, 20, "JOKO"),
  // VAN 21 has a null `nameDetails`.
  tx(52, 21, "PUTU"),
  // VAN 22 has a null KYC first name.
  tx(53, 22, "MADE"),
  // VAN 23 has a KYC with a string `_id`.
  tx(54, 23, "KETUT KETUT"),
];
