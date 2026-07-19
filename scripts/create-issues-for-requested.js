// Notion Meetings DB에서 "Wiki 동기화" 체크박스(버튼으로 켜짐)가 켜진 페이지를 찾아
// 해당 페이지 내용 그대로 GitHub 이슈로 등록하고, 처리 후 체크박스를 다시 끄는 스크립트.
//
// 트리거 흐름: Notion "Wiki 동기화" 버튼 클릭 -> 체크박스 켜짐
//   -> (이 스크립트가 주기적으로 폴링) 체크박스 켜진 페이지 발견
//   -> GitHub 이슈 생성(본문 = 회의 내용 그대로) + "GitHub Issue URL" 프로퍼티에 이슈 링크 기록
//   -> 체크박스 다시 끔 (중복 처리 방지)
//   -> 같은 워크플로우의 다음 단계(sync-notion-to-wiki.js)가 Wiki에도 반영
//
// 필요한 환경변수:
//   NOTION_TOKEN            Notion 내부 통합 토큰
//   NOTION_DATA_SOURCE_ID   Meetings 데이터소스 ID
//   GITHUB_ISSUE_TOKEN      이슈를 생성할 GitHub 토큰 (classic PAT, repo 스코프 필요 - WIKI_SYNC_PAT 재사용)
//   DEFAULT_ISSUE_REPO      (선택) Repository 프로퍼티가 비어있을 때 이슈를 등록할 기본 레포 ("owner/repo").
//                           비워두면 이 워크플로우가 실행 중인 레포(GITHUB_REPOSITORY)를 기본값으로 씁니다.

import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID;
const GITHUB_ISSUE_TOKEN = process.env.GITHUB_ISSUE_TOKEN;
const DEFAULT_ISSUE_REPO =
  process.env.DEFAULT_ISSUE_REPO || process.env.GITHUB_REPOSITORY || "";

const SYNC_PROPERTY = "Wiki 동기화";

if (!NOTION_TOKEN || !DATA_SOURCE_ID || !GITHUB_ISSUE_TOKEN) {
  console.error(
    "NOTION_TOKEN, NOTION_DATA_SOURCE_ID, GITHUB_ISSUE_TOKEN 환경변수가 필요합니다."
  );
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

function getTitle(page) {
  const props = page.properties;
  for (const key of Object.keys(props)) {
    if (props[key].type === "title") {
      const text = props[key].title.map((t) => t.plain_text).join("");
      return text || "제목없음";
    }
  }
  return "제목없음";
}

function getUrlValue(page, propName) {
  const prop = page.properties?.[propName];
  return prop?.type === "url" && prop.url ? prop.url : "";
}

// Repository 프로퍼티(예: https://github.com/owner/repo)에서 "owner/repo" 파싱
function parseOwnerRepo(repoUrl) {
  if (!repoUrl) return null;
  const m = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

async function findRequestedPages() {
  const results = [];
  let cursor = undefined;
  do {
    const res = await notion.dataSources.query({
      data_source_id: DATA_SOURCE_ID,
      start_cursor: cursor,
      filter: {
        property: SYNC_PROPERTY,
        checkbox: { equals: true },
      },
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function createGithubIssue(ownerRepo, title, body) {
  const res = await fetch(`https://api.github.com/repos/${ownerRepo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_ISSUE_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ title, body }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub 이슈 생성 실패 (${ownerRepo}): ${res.status} ${text}`);
  }
  return res.json();
}

async function main() {
  const pages = await findRequestedPages();
  console.log(`Wiki 동기화 요청된 문서 ${pages.length}건 발견.`);

  for (const page of pages) {
    const title = getTitle(page);
    const repoUrl = getUrlValue(page, "Repository");
    const ownerRepo = parseOwnerRepo(repoUrl) || DEFAULT_ISSUE_REPO;

    if (!ownerRepo) {
      console.warn(
        `  - "${title}": Repository 프로퍼티도 비어있고 기본 레포도 없어서 건너뜁니다.`
      );
      continue;
    }

    const mdBlocks = await n2m.pageToMarkdown(page.id);
    const mdString = n2m.toMarkdownString(mdBlocks).parent || "";
    const body =
      `> Notion에서 자동 등록된 이슈입니다. 원본: ${page.url}\n\n` + mdString;

    try {
      const issue = await createGithubIssue(ownerRepo, title, body);
      console.log(`  - "${title}" -> ${ownerRepo}#${issue.number} 이슈 생성 완료`);

      await notion.pages.update({
        page_id: page.id,
        properties: {
          "GitHub Issue URL": { url: issue.html_url },
          [SYNC_PROPERTY]: { checkbox: false },
        },
      });
    } catch (err) {
      // 실패한 건은 체크박스를 끄지 않고 남겨둬서 다음 폴링에서 재시도되게 함
      console.error(`  - "${title}" 처리 실패:`, err.message);
    }
  }

  console.log("이슈 등록 처리 완료.");
}

main().catch((err) => {
  console.error("이슈 등록 중 오류 발생:", err);
  process.exit(1);
});
