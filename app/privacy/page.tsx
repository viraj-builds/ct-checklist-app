import { Card, PageHeader } from "@/components/ui";
import { CONSENT_POINTS, SCREENSHOT_POINT } from "@/lib/consent";

export const metadata = { title: "Privacy — CT Integration Audit" };

const SECTIONS: { title: string; points: string[] }[] = [
  {
    title: "Your app build (Android / iOS)",
    points: [
      "Checked in your browser: the file isn't uploaded. Only the scan results (SDK version, settings, which CleverTap calls the code makes) are saved.",
      "If you choose to upload instead, the file is deleted right after analysis; a clean-up job removes anything left behind within an hour.",
    ],
  },
  {
    title: "Your CleverTap project",
    points: [
      "Your passcode is used only for the request you make and is never stored or logged. It stays in this browser tab until you reload.",
      "We read small samples of events and profiles to check them (read-only). The only thing we send is a test push or web push you ask for, to your test user.",
      "We save summaries: counts, percentages, data types, and masked examples (e.g. +91•••••10), never full emails or phone numbers.",
    ],
  },
  {
    title: "Live tests on a phone, Simulator or browser",
    points: [
      "We read the CleverTap SDK's own logs (Android logcat tag CleverTap, iOS subsystem com.clevertap.sdk) or, for websites, the requests the SDK sends.",
      "From phones we keep event and property names, data types and whether values are valid, not the values. From websites, emails and phone numbers are masked before saving.",
      "The website helper opens your site in its own Chrome profile, separate from your normal Chrome. Test-account passwords are typed into your login page and never stored.",
      "Helpers run only on your computer, listen on 127.0.0.1 and accept requests only from this site.",
    ],
  },
  {
    title: "Screenshots",
    points: [
      "Nothing is captured unless you tick the screenshots option on an audit. At the moment the tool doesn't take any screenshots; the option is there so that nothing can start capturing without your consent.",
      "If enabled, screenshots are stored with that audit and deleted with it.",
    ],
  },
  {
    title: "Keeping and deleting",
    points: [
      "Results stay with the audit until you delete it (Delete on the report). Deleting removes the results and anything stored with it.",
      "Only you and CleverTap staff can open your audits.",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Privacy" sub="What the audit reads, what it keeps, and what it never stores." />
      <Card className="p-6">
        <h2 className="text-lg font-bold">In short</h2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[15px] text-text-2">
          {CONSENT_POINTS.map((p) => (
            <li key={p}>{p}</li>
          ))}
          <li>{SCREENSHOT_POINT}</li>
        </ul>
      </Card>
      <div className="mt-6 space-y-6">
        {SECTIONS.map((s) => (
          <section key={s.title} aria-label={s.title}>
            <h2 className="text-lg font-bold">{s.title}</h2>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[15px] text-text-2">
              {s.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
