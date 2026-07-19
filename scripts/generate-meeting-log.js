// GitHub 이슈 중 "Scrum" 라벨이 붙은 것들을 모아서 회의록.md(위키 페이지)를 생성하는 스크립트.
// create-issues-for-requested.js가 만든 이슈(라벨: Scrum + DailyScrum/WeeklyMeeting/TeamMeeting/
// EmergencyMeeting, 본문에 "- **날짜**: ..." / "- **스크럼마스터**: ..." 메타라인 포함)를 읽어서
// 회의 유형별로 그룹핑한 표를 만듭니다. 표의 "제목"은 GitHub 이슈로 바로 연결됩니다.
//
// 필요한 환경변수:
//   GITHUB_ISSUE_TOKEN   이슈 조회용 GitHub 토큰 (WIKI_SYNC_PAT 재사용)
//   ISSUE_REPO           이슈를 조회할 레포 ("owner/repo"). 비워두면 이 워크플로우가
//                        실행 중인 레포(GITHUB_REPOSITORY)를 기본값으로 씁니다.
//   OUTPUT_DIR           (선택) 출력 폴더, 기본값 "wiki-sync-output" (sync-notion-to-wiki.js와 동일 폴더)

import fs from "fs";
import path from "path";

const GITHUB_ISSUE_TOKEN = process.env.GITHUB_ISSUE_TOKEN;
const ISSUE_REPO = process.env.ISSUE_REPO || process.env.GITHUB_REPOSITORY || "";
const OUTPUT_DIR = process.env.OUTPUT_DIR || "wiki-sync-output";

if (!GITHUB_ISSUE_TOKEN || !ISSUE_REPO) {
    console.error("GITHUB_ISSUE_TOKEN, ISSUE_REPO(또는 GITHUB_REPOSITORY) 환경변수가 필요합니다.");
    process.exit(1);
}

// 회의 유형 라벨 -> 표시용 그룹 정보 (제목, 색상 이모지)
const GROUPS = [
    { label: "DailyScrum", title: "Daily Scrum", icon: "🟢" },
    { label: "TeamMeeting", title: "Team Meeting", icon: "🟣" },
    { label: "WeeklyMeeting", title: "Weekly Scrum", icon: "🔵" },
    { label: "EmergencyMeeting", title: "Emergency Meeting", icon: "🔴" },
];

async function fetchScrumIssues() {
    const issues = [];
    let page = 1;
    while (true) {
        const res = await fetch(
            `https://api.github.com/repos/${ISSUE_REPO}/issues?labels=Scrum&state=all&per_page=100&page=${page}`,
            {
                headers: {
                    Authorization: `Bearer ${GITHUB_ISSUE_TOKEN}`,
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            }
        );
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`이슈 조회 실패: ${res.status} ${text}`);
        }
        const batch = await res.json();
        // PR도 /issues 엔드포인트에 섞여 나오므로 제외
        issues.push(...batch.filter((i) => !i.pull_request));
        if (batch.length < 100) break;
        page += 1;
    }
    return issues;
}

function extractMeta(body) {
    const dateMatch = body?.match(/\*\*날짜\*\*:\s*(.+)/);
    const masterMatch = body?.match(/\*\*스크럼마스터\*\*:\s*(.+)/);
    return {
        date: dateMatch ? dateMatch[1].trim() : "",
        scrumMaster: masterMatch ? masterMatch[1].trim() : "",
    };
}

function buildTable(issues) {
    if (issues.length === 0) {
        return "_등록된 항목이 없습니다._\n";
    }
    const sorted = [...issues].sort((a, b) => (b._meta.date || "").localeCompare(a._meta.date || ""));
    const lines = [
        "| 날짜 | 제목 | 스크럼마스터 | 상태 |",
        "|---|---|---|---|",
    ];
    for (const issue of sorted) {
        const status = issue.state === "open" ? "🟢 Open" : "🔴 Closed";
        const dateLabel = issue._meta.date || "-";
        const masterLabel = issue._meta.scrumMaster || "-";
        lines.push(`| ${dateLabel} | [${issue.title}](${issue.html_url}) | ${masterLabel} | ${status} |`);
    }
    return lines.join("\n") + "\n";
}

async function main() {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const issues = await fetchScrumIssues();
    console.log(`Scrum 라벨 이슈 ${issues.length}건 조회.`);

    for (const issue of issues) {
        issue._meta = extractMeta(issue.body || "");
    }

    const now = new Date().toISOString();
    const parts = [
        "# 📓 회의록",
        "",
        "> 이 페이지는 GitHub Actions가 `Scrum` 라벨이 붙은 이슈를 기반으로 자동 생성합니다. 직접 수정한 내용은 다음 실행 때 덮어써지니, 원본은 Notion에서 수정 후 \"Wiki 동기화\" 버튼을 다시 눌러주세요.",
        `> 마지막 생성: ${now}`,
        "",
    ];

    for (const group of GROUPS) {
        const groupIssues = issues.filter((i) => i.labels.some((l) => (l.name || l) === group.label));
        parts.push(`## ${group.icon} ${group.title}`, "", buildTable(groupIssues), "");
    }

    const filePath = path.join(OUTPUT_DIR, "회의록.md");
    fs.writeFileSync(filePath, parts.join("\n"));
    console.log(`회의록.md 생성 완료 (${filePath})`);

    // _Sidebar.md에 회의록 링크가 없으면 맨 위에 추가 (없으면 새로 생성)
    const sidebarPath = path.join(OUTPUT_DIR, "_Sidebar.md");
    const existing = fs.existsSync(sidebarPath) ? fs.readFileSync(sidebarPath, "utf-8") : "";
    if (!existing.includes("(회의록)")) {
        fs.writeFileSync(sidebarPath, `- [📓 회의록](회의록)\n\n${existing}`);
    }
}

main().catch((err) => {
    console.error("회의록 생성 중 오류 발생:", err);
    process.exit(1);
});