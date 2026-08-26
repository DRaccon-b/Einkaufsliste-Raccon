# Einkaufsliste-Raccon

Gemeinsame Einkaufsliste: Wer den Link öffnet, sieht dieselbe Liste. Häkchen
und Änderungen synchronisieren sich in Echtzeit über Supabase.

## Setup

1. Kostenloses Projekt auf [supabase.com](https://supabase.com) anlegen.
2. Im SQL Editor des Projekts den Inhalt von `supabase-schema.sql` ausführen.
3. `config.example.js` zu `config.js` kopieren und `url` sowie `anonKey` aus
   **Project Settings → API** eintragen.
4. `index.html` lokal öffnen oder die Dateien auf einem statischen Hoster
   (z. B. GitHub Pages, Netlify, Vercel) bereitstellen.

## Benutzung

- Beim ersten Öffnen ohne `?list=...` in der URL wird automatisch eine neue
  Liste erstellt und der Link dafür angezeigt.
- Diesen Link an andere Personen schicken — sie sehen und bearbeiten dieselbe
  Liste, Häkchen und neue Artikel erscheinen bei allen live.

## Tests

`test/smoke.js` startet die App in einem echten Browser gegen einen
Supabase-Stub (kein Netzwerkzugriff, keine echten Daten) und prüft Rendering,
Abhaken, die Spiegel-Kategorien zwischen beiden Listen, Suche und Löschen.

```sh
npm install playwright
node test/smoke.js
```

## Hinweis zur Sicherheit

Der Zugriffsschutz besteht aktuell nur darin, dass die Listen-ID (Teil des
Links) geheim bleibt — es gibt kein Login. Für eine private Familien-/
Freundesliste ist das ausreichend, für sensible Daten nicht geeignet.
