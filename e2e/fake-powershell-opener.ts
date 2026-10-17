/** Stands in for powershell.exe on Windows, compiled by writeCompiledBunProgram: it notes the file Invoke-Item was given. */
import { appendFileSync } from "node:fs";
appendFileSync(process.env.MIRADOR_OPENED_LOG!, `${process.env.MIRADOR_OPEN_FILE}\n`);
