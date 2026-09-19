# Quizshow starten

## Architektur

Der Python-Server ist die Autorität für eine laufende Quizrunde. Dauerhafte Daten liegen in einer
`QuizSession`; Änderungen werden als typisierte Befehle an `POST /api/host/commands` beziehungsweise
`POST /api/player/commands` geschickt. Der Server validiert die erwartete Revision, speichert die neue
Session atomar und veröffentlicht anschließend einen rollenbereinigten Snapshot.

Host, Spieler und Publikumsanzeige verwenden jeweils genau eine Verbindung zu `/ws/live`. Ein neu
geöffnetes Hostfenster erhält dadurch sofort denselben Bildschirm, dieselbe Runde, Punktestände und
Zeitinformationen wie das vorherige Fenster. Private Antworten, Stimmen und Gerätekennungen werden
aus Spieler- und Publikums-Snapshots entfernt.

Die wichtigsten Serverbausteine sind:

- `quizshow/app.py`: FastAPI-Anwendungsfabrik und Lebenszyklus
- `quizshow/domain/`: Sessionmodell, Befehle und rollenabhängige Projektionen
- `quizshow/session_service.py`: transaktionale Befehls- und Persistenzgrenze
- `quizshow/realtime.py`: Befehlsendpunkte und Live-WebSocket
- `quizshow/http_routes.py`: Ressourcen und noch benötigte Spieloperationen
- `quizshow/game_services.py`: einheitliche Schnittstelle zu den Spielmodulen

Sessiondateien werden atomar ersetzt. Beim Start wird eine vorhandene Session geladen; abgelaufene
aktive Runden wechseln vor dem ersten Snapshot in die Review-Phase. Veraltete Befehle werden mit HTTP
409 abgelehnt, sodass ein Browser zuerst den aktuellen Snapshot übernehmen muss.

## Installation

Benötigt wird Python 3.11 oder neuer. Erstellt einmalig eine virtuelle Umgebung und installiert die Anwendung mitsamt Testabhängigkeiten:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[test]"
npm install
```

Verwendet danach für Start und Tests den Python-Interpreter aus `.venv`.
Die visuellen Browsertests verwenden eine lokal installierte aktuelle Version von Google Chrome.

## Entwicklung und Qualitätsprüfung

Alle Prüfungen können unter Windows gemeinsam ausgeführt werden:

```powershell
.\scripts\check.ps1
```

Einzeln stehen folgende Befehle zur Verfügung:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"
npm test
npm run check
npm run test:visual
.\.venv\Scripts\python.exe -m ruff check .
```

`npm run test:visual` prüft Host-, Display- und Spieleransichten bei mehreren Desktop- und
Handygrössen auf Überlauf, verdeckte Bedienelemente und visuelle Abweichungen. Beabsichtigte
Designänderungen aktualisiert ihr nach einer Sichtprüfung mit `npm run test:visual:update`.

Der Server wird mit `python main.py` gestartet. Die Hostoberfläche ist nur vom lokalen Rechner aus
erreichbar; Geräte im LAN erhalten ausschließlich Spieler- und Publikumsressourcen.

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
.\.venv\Scripts\python.exe main.py
```

Die Spielleitung öffnet sich lokal. Handys verwenden den QR-Code in der Spielleitung und müssen sich normalerweise im selben WLAN befinden.

Die Quizshow ist für den lokalen Rechner und Geräte im selben Netzwerk vorgesehen. Eine Freigabe über das Internet wird derzeit nicht unterstützt.
