# Glubschi gewinnt

Vier gewinnt mit Glubschaugen, für zwei Leute an zwei Handys. Rote und gelbe Chips mit Wackelaugen fallen ins blaue Brett. Wer zuerst vier in einer Reihe hat (waagerecht, senkrecht oder schräg), gewinnt. Ihr müsst nicht am selben Ort sein: Einer schickt den Spiel-Link per WhatsApp, der andere tippt drauf, und los geht's.

**Spielen:** https://b2468246.github.io/glubschi-gewinnt/

Kein Konto, keine Anmeldung, kein App Store. Die Seite lässt sich wie eine App auf den Home-Bildschirm legen und startet dann im Vollbild.

## Als App installieren

### iPhone (Safari)

1. Den Link in **Safari** öffnen. Kommt er per WhatsApp, öffnet er sich dort oft im eingebauten Browser: dann auf das Safari-Symbol bzw. „In Safari öffnen" tippen.
2. Unten auf **Teilen** tippen (Quadrat mit Pfeil nach oben).
3. Runterscrollen, **„Zum Home-Bildschirm"** wählen, dann **„Hinzufügen"**.

### Android (Chrome)

1. Den Link in **Chrome** öffnen.
2. Oben rechts das **Menü** (drei Punkte) öffnen.
3. **„App installieren"** antippen (bei manchen Geräten heißt es „Zum Startbildschirm hinzufügen") und bestätigen.

Danach liegt Glubschi gewinnt als eigenes Symbol auf dem Handy, genau wie eine normale App.

## Spiel starten und per WhatsApp einladen

1. Glubschi gewinnt öffnen, deinen Namen eintippen und auf **„Neues Spiel starten"** tippen. Die App legt einen Spielraum mit zufälligem Raumcode an. Der Code steht im Link (`?raum=...`).
2. Auf **„Per WhatsApp einladen"** tippen und den Link an deinen Mitspieler schicken. Alternativ den Link kopieren und irgendwo einfügen.
3. Dein Mitspieler tippt auf den Link und landet im selben Raum. Jeder setzt sich auf einen freien Platz: Rot oder Gelb.
4. Abwechselnd eine Spalte antippen. Der Chip fällt nach unten, der andere sieht den Zug sofort.
5. Nach dem Spiel gibt's eine Revanche im selben Raum. Der Spielstand wird mitgezählt.

Tipp: Ton an. Die Glubschis haben Musik dabei.

## Datenschutz

- Die Spielzüge laufen über den öffentlichen Dienst [ntfy.sh](https://ntfy.sh) unter einem zufälligen Raumcode. Wer den Code bzw. den Link kennt, kann das Spiel sehen. Schick den Link also nur an die Person, mit der du spielen willst.
- ntfy.sh hält die Nachrichten eines Raums höchstens 12 Stunden vor, danach sind sie dort weg.
- Sonst wird nichts gespeichert: kein Konto, keine Telefonnummer, kein Tracking, keine Werbung. Nur dein eigenes Handy merkt sich lokal den letzten Spielstand, damit ein Neuladen nichts kaputt macht.

## Technik in kurz

Eine einzelne statische Webseite (Progressive Web App) auf GitHub Pages: `index.html` mit dem Spiel, `relay.js` für den Abgleich über ntfy.sh, `audio.js` für Musik und Sounds, `sw.js` als Service Worker (die App startet auch ohne Netz, Züge brauchen natürlich Internet) und `manifest.webmanifest` für die Installation.

Vor jedem Deploy `node tools/stamp.mjs` ausführen: Das hängt Prüfsummen an `audio.js` und `relay.js` (`?v=...`) und setzt die Version im Service Worker neu. Sonst kann eine neue `index.html` mit alten Skripten aus dem Cache starten. Tests: `node test/unit.test.js` und `node test/e2e.mjs` (braucht Google Chrome, spricht nie mit dem echten ntfy.sh).

## Credits

Musik und Sounds werden live im Browser erzeugt.
