// Notion 데이터베이스(Meetings — DailyScrum/Weekly/Team Meeting)를 읽어서
// Markdown 파일로 저장하는 스크립트
// 공식 Notion API(@notionhq/client)만 사용 — 비공식/쿠키 기반 API 아님
//
// 2025-09-03 API부터 데이터베이스 조회가 databases.query -> dataSources.query로
// 바뀌어서 그 방식으로 작성했습니다(데이터소스가 1개뿐인 데이터베이스는 구버전
// 방식도 당분간 동작하지만, 최신 SDK(v5+) 기준으로 새 방식을 씁니다).
//
// 필요한 환경변수:
//   NOTION_TOKEN          Notion 내부 통합(Internal Integration) 토큰
//   NOTION_DATA_SOURCE_ID 동기화할 Notion 데이터소스 ID (데이터베이스를 fetch하면
//                         나오는 collection://<id> 형태의 그 <id> 부분)
//   OUTPUT_DIR            (선택) 출력 폴더, 기본값 "wiki-sync-output"

import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import fs from "fs";
import path from "path";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID;
const OUTPUT_DIR = process.env.OUTPUT_DIR || "wiki-sync-output";

if (!NOTION_TOKEN || !DATA_SOURCE_ID) {
  console.error("NOTION_TOKEN, NOTION_DATA_SOURCE_ID 환경변수가 필요합니다.");
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

// 위키 파일명으로 쓸 수 있게 제목을 정리 (GitHub Wiki는 파일명이 곧 페이지명)
function slugify(title) {
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|#%]/g, "")
    .replace(/\s+/g, "-");
  return cleaned || "untitled";
}

// 데이터베이스의 title 속성값을 찾아서 반환
function getTitle(page) {
  const props = page.properties;
  for (const key of Object.keys(props)) {
    if (props[key].type === "title") {
      const titleArr = props[key].title;
      const text = titleArr.map((t) => t.plain_text).join("");
      return text || "제목없음";
    }
  }
  return "제목없음";
}

// Meetings 데이터베이스의 "Meeting type"(select), "Date"(date) 속성값을 찾아서 반환
// (스키마에 없는 프로퍼티명이면 조용히 빈 값 처리 — 다른 데이터소스에 재사용해도 안전)
function getSelectValue(page, propName) {
  const prop = page.properties?.[propName];
  if (prop?.type === "select" && prop.select) return prop.select.name;
  return "";
}

function getDateValue(page, propName) {
  const prop = page.properties?.[propName];
  if (prop?.type === "date" && prop.date) return prop.date.start;
  return "";
}

async function fetchAllPages(dataSourceId) {
  let results = [];
  let cursor = undefined;
  do {
    const res = await notion.dataSources.query({
      data_source_id: dataSourceId,
      start_cursor: cursor,
    });
    results = results.concat(res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const pages = await fetchAllPages(DATA_SOURCE_ID);
  console.log(`Notion 데이터소스에서 ${pages.length}개 문서를 찾았습니다.`);

  const sidebarLines = ["## 자동 동기화 문서 (Meetings)", ""];
  const now = new Date().toISOString();

  for (const page of pages) {
    const title = getTitle(page);
    const slug = slugify(title);
    const meetingType = getSelectValue(page, "Meeting type");
    const date = getDateValue(page, "Date");

    const mdBlocks = await n2m.pageToMarkdown(page.id);
    const mdString = n2m.toMarkdownString(mdBlocks).parent || "";

    const metaLine = [meetingType, date].filter(Boolean).join(" · ");

    const header =
      `> 이 문서는 Notion(Meetings)에서 자동 동기화되었습니다. 원본은 Notion에서 수정해주세요.\n` +
      `> 마지막 동기화: ${now}\n\n` +
      `# ${title}\n\n` +
      (metaLine ? `**${metaLine}**\n\n` : "");

    const filePath = path.join(OUTPUT_DIR, `${slug}.md`);
    fs.writeFileSync(filePath, header + mdString);
    sidebarLines.push(`- [${title}](${slug})`);

    console.log(`  - 동기화 완료: "${title}" -> ${slug}.md`);
  }

  // GitHub Wiki 사이드바 (파일명이 _Sidebar.md면 Wiki가 자동으로 사이드바로 인식)
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "_Sidebar.md"),
    sidebarLines.join("\n") + "\n"
  );

  console.log("모든 문서 동기화 완료.");
}

main().catch((err) => {
  console.error("동기화 중 오류 발생:", err);
  process.exit(1);
});
