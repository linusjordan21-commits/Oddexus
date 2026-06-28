============================================================
  ODDEXUS AUTOCLICKER — 4 casinon samtidigt
============================================================

Vad den gör
-----------
Öppnar GoGo Casino, BetMGM, LeoVegas och Expekt (spelet Big Bad Wolf) i samma
bot-Chrome och spinnar alla fyra samtidigt tills varje sidas omsättningsmål är
nått:

    Expekt    40 000 kr
    GoGo      60 000 kr
    BetMGM    80 000 kr
    LeoVegas  80 000 kr

(Målen ändrar du i sites.json om du vill.)

Hur omsättningen räknas
-----------------------
Boten klickar på spin-knappen. Ett klick är INTE samma sak som ett spin — ett
spin räknas först när saldot faktiskt minskar. Den minskningen är insatsen, och
den läggs till omsättningen. Ingen fast väntetid: boten reagerar på att saldot
rör sig.
  • En ev. vinst syns som en ökning av saldot och räknas inte som omsättning.
  • Free spins (ingen dragning) räknas korrekt som 0 kr.
  • Du sätter insatsen själv i spelet — boten behöver inte veta den i förväg,
    och den får variera.


INSTALLATION (görs en gång)
---------------------------
Mac / Linux:
    bash setup.sh

Windows:
    setup-windows.bat

Behöver du Python? På Mac:
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    brew install python@3.11


KÖRA BOTTEN
-----------
Mac / Linux:
    bash run.sh
Windows:
    run-windows.bat

Steg på skärmen:
 1. Första gången: klistra in din licensnyckel.
 2. Bot-Chrome öppnas med fyra flikar. Logga in på alla fyra sidor och öppna
    spelet så att SPIN-knappen och ditt SALDO syns. Tryck ENTER i terminalen.
 3. Kalibrering: för varje sida klickar du först på SPIN-knappen och sedan på
    ditt SALDO (siffran). Detta sparas (calibration.json) och hoppas över nästa
    gång. Vill du kalibrera om: kör med  --recalibrate
 4. Tryck  €  och Enter för att starta. Alla fyra sidor börjar spinna.
 5. Varje sida visar  omsättning x/mål  och stannar själv när målet är nått.


AVBROTT SOM BOTEN HANTERAR SJÄLV
--------------------------------
När saldot står stilla kollar boten efter avbrott och klickar sig igenom:

• Free spins — när "STARTA GRATISSPIN" (eller Start / Starta / Samla / Collect /
  Fortsätt) dyker upp klickar boten på den så att rundan körs igenom.
• 1h-kontrollen ("du har spelat så här länge / förlorat så här mycket") — boten
  kryssar FÖRST i "förstår"-rutan och klickar SEDAN Fortsätt. Ordningen är viktig
  eftersom Fortsätt-knappen ofta är inaktiv tills rutan är ikryssad.
• Fel-popups (t.ex. "wifi har slutat") — boten klickar OK, laddar om sidan och
  fortsätter sedan spinna.
• Inbyggda webbläsardialoger godkänns automatiskt.

Texterna styrs i sites.json:
  continue_buttons  klickas utan omladdning (free spins, Fortsätt)
  ack_buttons       "förstår"-rutan i 1h-kontrollen (kryssas i först)
  reload_buttons    klickas + sidan laddas om (fel-popups)
Står det något annat exakt på en knapp/ruta i ditt spel — lägg till exakt den
texten i rätt lista.

(Om en ruta ligger inne i själva SPELBILDEN i stället för som vanlig knapp kan
den behöva en egen kalibrering — säg till så lägger vi till det.)


VIKTIGT
-------
• Logga in i bot-Chrome som öppnas av botten — inte din vanliga Chrome.
  Inloggningen sparas lokalt (mappen bot-chrome-profile).
• Låt fönstret vara synligt (minimera det inte) så att alla flikar fortsätter
  snurra. Funkar det dåligt med fyra flikar i ett fönster: dra ut flikarna till
  fyra fönster och lägg dem sida vid sida.
• Allt körs lokalt. Det enda som skickas ut är licenskontrollen.

Filer som skapas lokalt (raderas/ignoreras i delning):
    .venv/                 Python-miljö
    bot-chrome-profile/    inloggningar
    calibration.json       dina klick-positioner
    license.txt            din licensnyckel
