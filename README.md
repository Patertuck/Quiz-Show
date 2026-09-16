# Quizshow starten

## Fragen konfigurieren

Wiederverwendbare Quiz-Varianten und ihre spielbaren Instanzen liegen getrennt unter `quiz-data`. Namen dürfen nur Kleinbuchstaben, Zahlen und Bindestriche enthalten. Eine Variante enthält die Fragen und Medien; mehrere Instanzen können dieselbe Variante verwenden:

```text
quiz-data/
├── variations/
│   └── mein-quiz-v1/
│       ├── quiz-config.json
│       └── assets/
└── instances/
    └── family-quiz-2026/
        ├── instance.json
        ├── logos/
        ├── state.json
        └── results/
```

Allgemeine Angaben wie `title` und `teams` stehen in `quiz-config.json` auf der obersten Ebene; die verfügbaren Spiele werden unter `games` eingetragen. Nur Spiele, deren Schlüssel vorhanden sind, erscheinen in der Spielauswahl.

```json
{
  "title": "Quizshow",
  "teams": [{ "name": "Team 1", "startingScore": 0 }],
  "games": {
    "sync": {
      "timeLimitSeconds": 8,
      "pointsPerSync": 100,
      "questions": [{ "id": "beispiel", "prompt": "Wer würde eher spontan verreisen?" }]
    }
  }
}
```

Unterstützte Schlüssel sind `jeopardy`, `ordering`, `listing` und `sync`. Ein vorhandenes Spiel muss vollständig konfiguriert sein und mindestens eine Frage enthalten. Das vollständige Format zeigt `questions.example.json`; kopiert diese Datei als `quiz-config.json` in eine neue Variante. Medienfelder wie `questionAudio` oder `answerAudio` sind optional. Medien liegen im `assets`-Ordner derselben Variante und werden beispielsweise als `assets/bilder/karte.png` referenziert.

Für Order Up legt `games.ordering.scoringMode` die Wertung fest. `relative` (Standard) vergibt `pointsPerCorrect` für jedes Paar von Elementen, das ein Team in der richtigen relativen Reihenfolge angeordnet hat. `exact` vergibt den Wert stattdessen für jede exakt richtige Position.

Die mitgelieferte Variante `quiz-data/variations/beispiel-quiz` enthält je eine kleine Runde aller vier Spieltypen. Sie erscheint nach einem frischen Klonen direkt in der Quiz-Auswahl und eignet sich zum Ausprobieren sowie als minimale Vorlage.

Die Quiz-Auswahl verwaltet global eindeutig benannte Quiz-Instanzen. Jede Instanz verweist in `instance.json` auf ihre Variante und speichert ihren vollständigen Spielstand sowie fertige Exporte im eigenen Ordner. Die zuletzt aktive Instanz wird gespeichert und beim nächsten Serverstart automatisch wieder ausgewählt.

### Logos pro Quiz-Instanz

Die Standardlogos liegen öffentlich unter `assets/Logos`. Eine Quiz-Instanz kann einzelne Logos ersetzen, indem im eigenen Ordner `quiz-data/instances/<instanzname>/logos/` eine PNG-Datei mit demselben Namen abgelegt wird. Nicht vorhandene Ersetzungen verwenden weiterhin das jeweilige Standardlogo:

- `logo_Quiz.png`
- `Logo_Jeopardy.png`
- `Logo_Order_Up.png`
- `Logo_List_It.png`
- `Logo_Sync_Up.png`

Die Dateinamen inklusive Gross-/Kleinschreibung müssen exakt übereinstimmen. Neue Instanzen erhalten den leeren `logos`-Ordner automatisch. Weil Instanzlogos innerhalb von `quiz-data` liegen, werden sie mit dem beschriebenen Quiz-Backup gesichert.

## Sichern und wiederherstellen

Mit Ausnahme der mitgelieferten Variante `beispiel-quiz` ist der Ordner `quiz-data` bewusst nicht im Repository enthalten. Beendet den Quizserver und kopiert diesen einen Ordner in euer Backup. Nach dem Klonen auf einem anderen Gerät kopiert ihr ihn unverändert neben `main.py` zurück; damit sind alle eigenen Varianten, fortsetzbaren Instanzen und Ergebnisse wieder vorhanden.

Varianten werden nicht gegen bestehende Instanzen geprüft: Wer Fragen oder Medien nachträglich ändert, ist selbst für die Kompatibilität mit gespeicherten Spielständen verantwortlich.

## Im lokalen Netzwerk

Der normale Start bleibt unverändert:

```powershell
python main.py
```

Die Spielleitung öffnet sich lokal. Handys verwenden den QR-Code in der Spielleitung und müssen sich normalerweise im selben WLAN befinden.

## Temporär im Internet freigeben

Diese Variante ist für private Quizrunden mit ungefähr bis zu 15 Handys gedacht. Das Spiel und alle Spielstände bleiben auf dem Computer der Spielleitung; Cloudflare stellt nur für die laufende Sitzung einen zufälligen HTTPS-Link bereit.

1. `cloudflared` einmalig installieren:

   ```powershell
   winget install --id Cloudflare.cloudflared
   ```

   Öffnet danach ein neues PowerShell-Fenster. Falls `cloudflared --version` im bereits geöffneten Terminal noch nicht funktioniert, lädt dieser Befehl den persistenten PATH neu:

   ```powershell
   $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
   ```

2. Ein neues Terminal öffnen und die Quizshow öffentlich starten:

   ```powershell
   python main.py --public
   ```

3. In der lokalen Spielleitung den QR-Code öffnen. Die Handys scannen den angezeigten Spielerlink. Für einen separaten Anzeige-Laptop den dort aufgeführten Link zur Publikumsanzeige öffnen und den Browser in den Vollbildmodus versetzen.

Der öffentliche Link ändert sich bei jedem Start. Jeder, der ihn kennt, kann als Spieler beitreten. Die Spielleitungsoberfläche und ihre Steuerungs-Endpunkte sind über den Tunnel gesperrt. Mit `Ctrl+C` werden Server und Tunnel beendet. Bei einem Internetausfall bleibt das Spiel im lokalen Netzwerk erreichbar.

Quick Tunnels sind ein bequemer Dienst für private Spiele, aber kein Ersatz für ein dauerhaft betriebenes oder großes öffentliches Angebot.
Sie unterstützen keine Server-Sent Events. Die Quizshow erkennt deshalb `trycloudflare.com` automatisch und verteilt Live-Updates per HTTP-Polling. Im lokalen Netzwerk bleiben die schnelleren Event-Streams aktiv. Eine Verzögerung von bis zu ungefähr einer Sekunde über den öffentlichen Link ist normal.
