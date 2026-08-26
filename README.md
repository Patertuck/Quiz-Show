# Quizshow starten

## Fragen konfigurieren

Die Quizshow lädt standardmässig `questions.json`. Allgemeine Angaben wie `title` und `teams` stehen auf der obersten Ebene; die verfügbaren Spiele werden unter `games` eingetragen. Nur Spiele, deren Schlüssel vorhanden sind, erscheinen in der Spielauswahl.

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

Unterstützte Schlüssel sind `jeopardy`, `ordering`, `listing` und `sync`. Ein vorhandenes Spiel muss vollständig konfiguriert sein und mindestens eine Frage enthalten. Das vollständige Format zeigt `questions.example.json`. Medienfelder wie `questionAudio` oder `answerAudio` sind optional; fehlen sie, werden keine Audiosteuerungen angezeigt.

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

## Geheimnisse

API-Schlüssel gehören nur in eine ignorierte lokale Konfigurationsdatei und nie ins Repository. Einen bereits weitergegebenen oder offengelegten Schlüssel beim jeweiligen Anbieter widerrufen und neu erstellen.
