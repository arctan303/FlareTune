# FlareTune – Schnellstart

[Deutsch](quickstart.de.md) · [English](../README.en.md) · [简体中文](../README.md)

Deine private Musikbibliothek auf Cloudflare, ohne einen VPS zu verwalten. Die Anwendung läuft auf Workers, Metadaten liegen in D1 und Audio sowie Cover in privatem R2. R2 Standard bietet monatlich 10 GB-month kostenlos. Gesamtnutzung des Kontos, Anfragen und optionale Dienste können Kosten verursachen: [Kosten und Grenzen (Englisch)](deployment.en.md).

In der [Demo ohne Anmeldung](demo.en.md) kannst du abspielen, suchen, Favoriten speichern und Playlists bearbeiten. Persönliche Daten bleiben in diesem Browser; Verwaltung und KI sind schreibgeschützte Beispiele.

1. Aktiviere R2 in deinem Cloudflare-Konto und erstelle eigene Ressourcen über [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/arctan303/FlareTune).
2. Lege ein zufälliges `SETUP_SECRET` mit mindestens 32 Zeichen fest und bewahre es sicher auf.
3. Öffne die bereitgestellte Adresse, bestätige das Secret, erstelle das erste Administratorkonto und melde dich an.
4. Importiere Musik, die du verwenden darfst. Für viele Dateien gibt es das [lokale Importgerät (Englisch)](../tooling/ingest-agent/README.en.md).

Wähle Deutsch in den persönlichen Einstellungen. In einer normalen Instanz werden Favoriten und Playlists im Konto gespeichert; der Wiedergabeverlauf bleibt im aktuellen Browser. KI ist optional. Sichere D1 und R2 vor Updates und überschreibe bestehende Instanzen nicht durch eine Neuinitialisierung.

Ausführliche Anleitungen auf Englisch: [Nutzung](using-flaretune.en.md) · [Bereitstellung](deployment.en.md) · [Verwaltung](administration.en.md) · [Subsonic](subsonic.en.md).
