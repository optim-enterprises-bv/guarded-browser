# Built by scripts/dist.mjs from electron-builder's linux-unpacked output. Not relocatable.
%global debug_package %{nil}
%global _build_id_links none
# Electron ships its own, already-stripped binaries and $ORIGIN rpaths: skip the brp scripts
%global __os_install_post %{nil}
%global __strip /bin/true

Name:           guarded-browser
Version:        %{gb_version}
Release:        1%{?dist}
Summary:        Desktop web browser with a prompt-injection-hardened AI agent
# The app is Apache-2.0; the bundled Electron / Chromium and npm modules carry their own licenses
# (see /opt/guarded-browser/LICENSE.electron.txt, LICENSES.chromium.html and the module licenses).
License:        Apache-2.0 AND MIT AND BSD-3-Clause AND LicenseRef-Chromium-Bundled
URL:            https://www.optimcloud.com/work/guarded-browser
ExclusiveArch:  x86_64
AutoReqProv:    no
Requires:       gtk3, nss, alsa-lib, libXScrnSaver, libXtst, mesa-libgbm, libdrm, at-spi2-core, xdg-utils

%description
Guarded Browser is a desktop web browser (Electron) with a built-in AI agent that is
architecturally defended against prompt injection: a privileged planner that never reads pages,
a quarantined reader without tools, a taint / data-flow policy, an action judge, human
confirmation for outward actions, an egress-filtering proxy per profile, host reputation feeds and
an append-only audit log. Profiles, split view, themes, history and bookmarks included.
The prompt-injection guard model is downloaded on first run and verified against pinned checksums.

%install
mkdir -p %{buildroot}/opt/guarded-browser %{buildroot}%{_bindir} %{buildroot}%{_datadir}/applications
cp -a %{gb_src}/. %{buildroot}/opt/guarded-browser/
ln -s ../../opt/guarded-browser/guarded-browser %{buildroot}%{_bindir}/guarded-browser
install -m 0644 %{gb_desktop} %{buildroot}%{_datadir}/applications/guarded-browser.desktop
for n in 16 32 48 64 128 256 512; do
  mkdir -p %{buildroot}%{_datadir}/icons/hicolor/${n}x${n}/apps
  install -m 0644 %{gb_icons}/${n}x${n}.png %{buildroot}%{_datadir}/icons/hicolor/${n}x${n}/apps/guarded-browser.png
done

%post
touch --no-create %{_datadir}/icons/hicolor >/dev/null 2>&1 || :
update-desktop-database -q %{_datadir}/applications >/dev/null 2>&1 || :

%postun
update-desktop-database -q %{_datadir}/applications >/dev/null 2>&1 || :
if [ $1 -eq 0 ]; then
  touch --no-create %{_datadir}/icons/hicolor >/dev/null 2>&1 || :
  gtk-update-icon-cache -q %{_datadir}/icons/hicolor >/dev/null 2>&1 || :
fi

%posttrans
gtk-update-icon-cache -q %{_datadir}/icons/hicolor >/dev/null 2>&1 || :

%files -f %{gb_filelist}
%defattr(-,root,root,-)
%{_bindir}/guarded-browser
%{_datadir}/applications/guarded-browser.desktop
%{_datadir}/icons/hicolor/*/apps/guarded-browser.png

%changelog
* Sat Oct 03 2026 Optim Enterprises B.V. - 0.2.2-1
- Mail: HTML messages shown in a locked-down view (no JavaScript, own session, sanitized, CSP)
- Mail: remote content blocked until Load External Content, for that display only
- Mail: compose, drafts, outbox and SMTP send (implicit TLS 465 or strict STARTTLS 587)
- Mail: attachments (listed from BODYSTRUCTURE, download on click, Open behind a confirmation,
  attach and forward on send, inline cid: images)
- Injection X-ray: hidden text, guard verdicts, third-party hosts and off-site forms per tab
- AI chat panel: a quarantined, tool-less chat role about the current tab
- MCP server for local AI programs, and confirmations answerable from the phone (Telegram)
- Inbox triage by a quarantined role that sees one message's screened fields at a time
- Recipes (model-free replay of a finished task) and read-only scheduled watchers
- Side panels: the page starts at the panel's edge, not 220 px past it

* Fri Oct 02 2026 Optim Enterprises B.V. - 0.2.2-1
- Mail client (IMAP over implicit TLS, encrypted secrets, himalaya import, accounts column)
- Confirmation dialogs show exactly what is approved; task secrets cannot leave by navigation
- Post-task gate lifts on commit with an unload tombstone; collision-proof confirmation ids

* Mon Sep 28 2026 Optim Enterprises B.V. - 0.1.0-1
- First package: browser, agent, profiles, split view, themes, history and bookmarks
