// How each website item that isn't decided by the crawl / API gets checked.
// `auto` = it ticks itself once the step in Website tests has run.
export const WEB_HOW_TO_CHECK: Record<string, { auto: boolean; how: string }> = {
  "web-t1-sdk-head": { auto: true, how: "Website tests → Check my website. We open the site and see where CleverTap loads and what it sends." },
  "web-t1-gdpr": { auto: true, how: "Ticks itself from the website check: we look for clevertap.privacy.push({optOut, useIP}) and getLocation()." },
  "web-t1-utm": { auto: true, how: "The website check opens your site with test utm_ tags; “Check CleverTap again” confirms UTM Visited on that visitor." },
  "web-t2-identity": { auto: true, how: "Live session: log in on your site any way you like (or give a test login to the automatic check) — we see the Identity / Email the site sends." },
  "web-t2-onuserlogin": { auto: true, how: "Live session: log in on your site (or give a test login to the automatic check) — we watch for clevertap.onUserLogin.push." },
  "web-t2-profile-push": { auto: true, how: "In the live session, edit your profile on the site (name, phone, preferences) and save — we see clevertap.profile.push." },
  "web-t2-anon": { auto: true, how: "The website check visits as a logged-out user; “Check CleverTap again” finds that anonymous profile." },
  "web-t2-onuserlogin-existing": { auto: true, how: "Live session → Reopen the site while logged in (or a test login in the automatic check): onUserLogin should run again for the returning user." },
  "web-t2-phone": { auto: true, how: "Log in with a test user that has a phone number — it must be sent as +<country code><number>." },
  "web-t3-custom-events": {
    auto: true,
    how: "We follow links but never click buttons. Trigger your custom events on the site (view a product, add to cart…), then press “Check CleverTap again”.",
  },
  "web-t3-web-push": {
    auto: true,
    how: "Website tests → Live session: log in, click Allow, then Send test push — we see it arrive in Chrome by ourselves. (Without the helper: send it and press Check delivery.)",
  },
  "web-t3-deeplink": {
    auto: true,
    how: "Website tests → Live session → Send push with link, then click the notification — we see which page opens and tick it.",
  },
};
