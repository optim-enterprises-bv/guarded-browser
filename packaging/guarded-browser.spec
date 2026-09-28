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
* Mon Sep 28 2026 Optim Enterprises B.V. - 0.1.0-1
- First package: browser, agent, profiles, split view, themes, history and bookmarks
