// Gehoert am iMac nach
//   ~/.config/mozilla/firefox/t3zznu7f.default-release/user.js
//
// Nebenschirm: die Tafel ist ein Dauerfenster, keine Surf-Sitzung.
// Ohne diese Zeilen holt Firefox beim Neustart die alte Sitzung zurueck
// und das Startskript legt seine URL nochmal obendrauf — so sammelten
// sich mit jedem Neuladen weitere Nebenschirm-Tabs an.
user_pref("browser.startup.page", 1);
user_pref("browser.startup.homepage", "http://homeserver:8300/");
user_pref("browser.sessionstore.resume_from_crash", false);
