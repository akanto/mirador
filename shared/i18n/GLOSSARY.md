# Hungarian glossary

Mirador's Hungarian uses the informal *te* form ("Válaszd ki", "Kattints újra").
These terms stay the same everywhere:

| English | Magyar |
| --- | --- |
| agent | ágens |
| subagent | alágens |
| canvas | vászon |
| host | host |
| workspace | munkaterület |
| conversation | beszélgetés |
| session | munkamenet |
| profile | profil |
| turn | kör |
| tour | bejárás |
| review (code) | átnézés |
| prompt | prompt |
| message box | üzenetmező |
| terminal | terminál |
| plugin | bővítmény |
| palette | (parancs)paletta |
| checklist | ellenőrzőlista |
| History (canvas) | Előzmények |
| queue / queued | sor / sorba állított |
| device | készülék |
| machine | gép |
| rail | sáv |
| tool (agent's) | eszköz |
| approve / approval | jóváhagy / jóváhagyás |
| statusline | állapotsor |
| fork (a session) | elágaztatás |
| invite code / link | meghívókód / meghívólink |
| keyboard shortcuts | billentyűparancsok |

Never attach a suffix or an article to a value filled in at runtime (a name, a version, a number):
vowel harmony and a/az can't be chosen in advance. Phrase around it, as in "Ezt futtatja: ${program}".
After a number, nouns stay singular: "3 fájl", "5 perc".

## Names the tooltips already use

The Hungarian tooltips name these buttons and labels; translate the UI with the same words:
Leállítás, Kényszerített leállítás, Küldés, Szerkesztés, Előzmények, Ellenőrzőlista, Modell (menu), Mód,
Rád vár / Kész / Sikertelen / Olvasatlan, Gépek…, Csere, Egyesített / Osztott, Használat, Cím mentése,
Összes eltávolítása, Modellek ezen a Macen, „a körhöz csatlakozik” / „a kör után”.
The palette command "Elrendezés visszaállítása az alapértelmezettre" is `t.settings.layout.resetCommand`: reuse it.
