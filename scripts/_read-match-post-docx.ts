import { readFileSync } from "fs";
// Just extract raw XML text from the docx (a zip file); take document.xml
import * as unzip from "unzipper";
import { Readable } from "stream";
const buf = readFileSync("C:/Users/peter/OneDrive/Documents/MarkForYou/PSLE-Grammar-7-Rules-Match-Post.docx");
Readable.from(buf).pipe(unzip.Parse()).on("entry", (entry: any) => {
  if (entry.path === "word/document.xml") {
    entry.buffer().then((b: Buffer) => {
      const text = b.toString("utf8").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      console.log(text);
    });
  } else entry.autodrain();
});
