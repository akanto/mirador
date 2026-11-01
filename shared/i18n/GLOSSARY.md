# Glossary

Mirador's Hungarian uses the informal *te* form ("Válaszd ki", "Kattints újra").
Its Spanish is neutral international Spanish in the *tú* form ("Elige", "Haz clic de nuevo"): no *vosotros*, and no
words only one region uses (*equipo*, not *ordenador* or *computadora*; *archivo*, not *fichero*; *durazno*, not *melocotón*).
These terms stay the same everywhere:

| English | Magyar | Español |
| --- | --- | --- |
| agent | ágens | agente |
| subagent | alágens | subagente |
| canvas | vászon | lienzo |
| host | host | host |
| workspace | munkaterület | espacio de trabajo |
| conversation | beszélgetés | conversación |
| session | munkamenet | sesión |
| profile | profil | perfil |
| turn | kör | turno |
| tour | bejárás | recorrido |
| review (code) | átnézés | revisión |
| prompt | prompt | prompt |
| message box | üzenetmező | cuadro de mensaje |
| terminal | terminál | terminal |
| plugin | bővítmény | complemento |
| palette | (parancs)paletta | paleta |
| checklist | ellenőrzőlista | lista de verificación |
| History (canvas) | Előzmények | Historial |
| queue / queued | sor / sorba állított | cola / en cola |
| device | készülék | dispositivo |
| machine | gép | máquina |
| computer | számítógép | equipo |
| rail | sáv | barra de máquinas |
| tool (agent's) | eszköz | herramienta |
| approve / approval | jóváhagy / jóváhagyás | aprobar / aprobación |
| statusline | állapotsor | línea de estado |
| fork (a session) | elágaztatás | bifurcar |
| invite code / link | meghívókód / meghívólink | código / enlace de invitación |
| keyboard shortcuts | billentyűparancsok | atajos de teclado |
| Changes (canvas) | Változások | Cambios |
| Point and ask | Mutass és kérdezz | Señala y pregunta |
| Dismiss | Elvetés | Descartar |
| Settings | Beállítások | Configuración |
| Add / Remove / Delete | Hozzáadás / Eltávolítás / Törlés | Agregar / Quitar / Eliminar |
| uncommitted | nem commitolt | sin confirmar |
| effort (thinking) | erőfeszítés | esfuerzo |

## Hungarian

Never attach a suffix or an article to a value filled in at runtime (a name, a version, a number):
vowel harmony and a/az can't be chosen in advance. Phrase around it, as in "Ezt futtatja: ${program}".
After a number, nouns stay singular: "3 fájl", "5 perc".

The Hungarian tooltips name these buttons and labels; translate the UI with the same words:
Leállítás, Kényszerített leállítás, Küldés, Szerkesztés, Előzmények, Ellenőrzőlista, Modell (menu), Mód,
Rád vár / Kész / Sikertelen / Olvasatlan, Gépek…, Csere, Egyesített / Osztott, Használat, Cím mentése,
Összes eltávolítása, Modellek ezen a Macen, „a körhöz csatlakozik” / „a kör után”.
The palette command "Elrendezés visszaállítása az alapértelmezettre" is `t.settings.layout.resetCommand`: reuse it.

## Spanish

Don't put an article or a gendered word in front of a value filled in at runtime (a name, a file, a version): its
gender can't be known in advance. Phrase around it, as in "Ejecuta: ${program}". Nouns after a number take the plural
unless the number is 1, as in English: use the `plural` helper the English file uses.
Button and menu labels are infinitives or nouns ("Enviar", "Detener", "Historial"), not imperatives; sentences that
tell the user what to do use *tú* imperatives ("Elige un perfil").
"Terminal" is feminine: *la terminal*, *las terminales*. Keys keep their English names (Enter, Tab, Esc), not *Intro*.
Sentence case, as in English. Spanish punctuation: ¿…? and ¡…!.

The Spanish tooltips name these buttons and labels; translate the UI with the same words:
Esperándote / Listo / Falló / No leída, Usar esta, Guardar dirección, Quitar todo, Modelos en este Mac, Intercambiar,
Modelo (menu), Modo.

## Every language

Spoken command words stay English, as the voice parser only knows those: “stop”, “repeat that”, “help”, “yes”,
“the others”, “thanks”. So do option names the agent sends, such as its “allow” option.
