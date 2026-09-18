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

Die Quizshow ist für den lokalen Rechner und Geräte im selben Netzwerk vorgesehen. Eine Freigabe über das Internet wird derzeit nicht unterstützt.
