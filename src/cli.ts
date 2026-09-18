#!/usr/bin/env node
import { formatInspectReport, runInspect } from "./commands/inspect.js";
import { formatStatusReport, runStatus } from "./commands/status.js";
import { formatTaskReport, runTask } from "./commands/task.js";
import { formatHistoryReport, runHistory } from "./commands/history.js";
import { runApprove } from "./commands/approve.js";
import { parseCompleteCliArgs, runComplete } from "./commands/complete.js";
import { ADVANCE_TARGET_PHASES_HELP, parseAdvanceCliArgs, runAdvance } from "./commands/advance.js";
import { runReset } from "./commands/reset.js";
import { formatExecuteReport, runExecuteCommand } from "./commands/execute.js";
import { formatPlanReport, runPlanCommand } from "./commands/plan.js";
import { formatCommitReport, runCommitCommand } from "./commands/commit.js";
import { formatPushReport, runPushCommand } from "./commands/push.js";

const USAGE = `cookvideo-agent — CookVideo local control-plane CLI

Usage:
  cookvideo-agent inspect   Verify the CookVideo repository and this control plane's state
  cookvideo-agent status    Print a concise summary of the current engineering state
  cookvideo-agent task      Show the current task's lifecycle phase, risk and approval status
  cookvideo-agent history   List every task archived to .cookvideo/TASK_HISTORY.json by
                            reset or plan --replace (read-only)
  cookvideo-agent approve   Move a task from APPROVAL_REQUIRED to APPROVED (no commit/push/deploy)
  cookvideo-agent advance --to <${ADVANCE_TARGET_PHASES_HELP}> [--note <text>]
                            Record a single real-world lifecycle step: TESTING->REVIEW,
                            REVIEW->APPROVAL_REQUIRED, APPROVED->COMMITTING,
                            COMMITTING->DEPLOYING, or DEPLOYING->VERIFYING. Refuses unless the
                            task is already in the exact required source phase. --note is
                            free-text, purely descriptive (e.g. a commit hash or deploy ID) and
                            never verified. Never edits CookVideo or runs git commit/push/deploy
                            -- it only records that a human says the step happened.
  cookvideo-agent complete [--commit <hash>]
                            Move a task's remaining lifecycle phases through to COMPLETED, only
                            when every remaining transition is valid per the lifecycle rules
                            (refuses from FAILED/BLOCKED/CANCELLED, and from approvalStatus
                            PENDING/REJECTED). Optionally records the CookVideo commit hash the
                            implementation was committed as. Never edits CookVideo, invokes
                            Claude, or runs git commit/push/deploy.
  cookvideo-agent reset     Archive the current task (if any) to .cookvideo/TASK_HISTORY.json,
                            then reset task state to empty (does not delete source or repo
                            files)
  cookvideo-agent execute [--execute] [--target <name>]
                            Prepare (and, only in local execution mode with --execute, run)
                            a Claude implementation attempt for the current task. Defaults to
                            SAFE/DRY-RUN: prepares and prints everything but invokes nothing.
                            --target selects which approved repository (see
                            .cookvideo/EXECUTION_POLICY.md) Claude's working directory will
                            be; defaults to CookVideoAgent (this repository) if omitted.
  cookvideo-agent plan --file <path> [--replace]
                            Submit a structured JSON task definition (from an external
                            planner such as ChatGPT) and record it as the new PLANNED task.
                            Refuses to overwrite an existing active task unless --replace is
                            passed, and refuses --replace itself while that task is
                            IMPLEMENTING/TESTING/REVIEW/APPROVAL_REQUIRED/APPROVED/
                            COMMITTING/DEPLOYING/VERIFYING. A --replace archives the
                            outgoing task to .cookvideo/TASK_HISTORY.json first. Never edits
                            CookVideo, invokes Claude, or runs git commit/push.
  cookvideo-agent commit [--execute]
                            Requires phase APPROVED and approvalStatus APPROVED. Prepares (and,
                            only in local git-write mode with --execute, runs) a real
                            \`git add\`/\`git commit\` against the CookVideo repository only, using
                            a deterministic, non-overridable commit message. Defaults to
                            SAFE/DRY-RUN. Never pushes -- see \`push\` below. See
                            .cookvideo/GIT_WRITE_POLICY.md.
  cookvideo-agent push [--execute]
                            Requires phase COMMITTING. Prepares (and, only in local git-write
                            mode with --execute, runs) a real \`git push\` of the current branch
                            against the CookVideo repository only. Never chained from \`commit\`
                            -- always its own separate, explicit action. A rejected/diverged
                            push fails visibly and is never force-resolved. Never deploys
                            anything. See .cookvideo/GIT_WRITE_POLICY.md.
  cookvideo-agent help      Show this message
`;

async function main(argv: string[]): Promise<number> {
  const command = argv[2];

  switch (command) {
    case "inspect": {
      console.log(formatInspectReport(runInspect()));
      return 0;
    }
    case "status": {
      console.log(formatStatusReport(runStatus()));
      return 0;
    }
    case "task": {
      console.log(formatTaskReport(runTask()));
      return 0;
    }
    case "history": {
      console.log(formatHistoryReport(runHistory()));
      return 0;
    }
    case "approve": {
      const result = runApprove();
      console.log(result.message);
      return result.ok ? 0 : 1;
    }
    case "advance": {
      const parsed = parseAdvanceCliArgs(argv.slice(3));
      if (parsed.invalidToValue !== null) {
        console.error(
          `cookvideo-agent advance: "${parsed.invalidToValue}" is not a valid --to target. ` +
            `Expected one of: ${ADVANCE_TARGET_PHASES_HELP}.\n`,
        );
        console.error(USAGE);
        return 1;
      }
      if (parsed.toPhase === null) {
        console.error("cookvideo-agent advance: --to <phase> is required.\n");
        console.error(USAGE);
        return 1;
      }
      const result = runAdvance(parsed.toPhase, parsed.options);
      console.log(result.message);
      return result.ok ? 0 : 1;
    }
    case "complete": {
      const result = runComplete(parseCompleteCliArgs(argv.slice(3)));
      console.log(result.message);
      return result.ok ? 0 : 1;
    }
    case "reset": {
      const result = runReset();
      console.log(result.message);
      return 0;
    }
    case "execute": {
      const rest = argv.slice(3);
      const executeFlag = rest.includes("--execute");
      const targetFlagIndex = rest.indexOf("--target");
      const targetName = targetFlagIndex !== -1 ? rest[targetFlagIndex + 1] : undefined;
      const result = await runExecuteCommand(executeFlag, targetName);
      console.log(formatExecuteReport(result));
      return result.ok ? 0 : 1;
    }
    case "plan": {
      const rest = argv.slice(3);
      const fileFlagIndex = rest.indexOf("--file");
      const filePath = fileFlagIndex !== -1 ? rest[fileFlagIndex + 1] : undefined;
      const replace = rest.includes("--replace");

      if (filePath === undefined || filePath.length === 0 || filePath.startsWith("--")) {
        console.error("cookvideo-agent plan: --file <path> is required.\n");
        console.error(USAGE);
        return 1;
      }

      const result = runPlanCommand({ filePath, replace });
      console.log(formatPlanReport(result));
      return result.ok ? 0 : 1;
    }
    case "commit": {
      const executeFlag = argv.slice(3).includes("--execute");
      const result = runCommitCommand(executeFlag);
      console.log(formatCommitReport(result));
      return result.ok ? 0 : 1;
    }
    case "push": {
      const executeFlag = argv.slice(3).includes("--execute");
      const result = runPushCommand(executeFlag);
      console.log(formatPushReport(result));
      return result.ok ? 0 : 1;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined: {
      console.log(USAGE);
      return command === undefined ? 1 : 0;
    }
    default: {
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      return 1;
    }
  }
}

main(process.argv).then(
  (code) => {
    process.exit(code);
  },
  (err: unknown) => {
    console.error("cookvideo-agent: unexpected error");
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  },
);
