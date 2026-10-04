// Dev check: run the CleverTap API verifier against a real account.
//
//   CT_ACCOUNT_ID=XXX-XXX-XXXX CT_REGION=eu1 CT_PASSCODE=... \
//     npx tsx --conditions=react-server scripts/ct-api-check.ts [test-identity] [event names...]
//
// The passcode is read from the environment only and never printed.
import { verifyAppAccount, checkTestUser } from "../lib/clevertap/verify";

const accountId = process.env.CT_ACCOUNT_ID;
const passcode = process.env.CT_PASSCODE;
const region = process.env.CT_REGION ?? "eu1";
if (!accountId || !passcode) {
  console.error("Set CT_ACCOUNT_ID and CT_PASSCODE (and CT_REGION).");
  process.exit(1);
}
const [identity, ...events] = process.argv.slice(2);
const creds = { accountId, passcode, region };

(async () => {
  const f = await verifyAppAccount(creds, { platform: "Android", customEvents: events });
  console.log(JSON.stringify({ ...f, profiles: f.profiles && { ...f.profiles, phoneInvalidExamples: undefined } }, null, 2));
  if (identity) console.log("test user:", JSON.stringify(await checkTestUser(creds, identity, "Android"), null, 2));
})();
