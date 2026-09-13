#!/usr/bin/env node
import { formatInspectReport, runInspect } from "./commands/inspect.js";
import { formatStatusReport, runStatus } from "./commands/status.js";
import { formatTaskReport, runTask } from "./commands/task.js";
import { runApprove } from "./commands/approve.js";
import { parseCompleteCliArgs, runComplete } from "./commands/complete.js";
import { runReset } from "./commands/reset.js";
import { formatExecuteReport, runExecuteCommand } from "./commands/execute.js";
import { formatPlanReport, runPlanCommand } from "./commands/plan.js";

const USAGE = `cookvideo-agent — CookVideo local control-plane CLI

Usage:
  cookvideo-agent inspect   Verify the CookVideo repository and this control plane's state
  cookvideo-agent status    Print a concise summary of the current engineering state
  cookvideo-agent task      Show the current task's lifecycle phase, risk and approval status
  cookvideo-agent approve   Move a task from APPROVAL_REQUIRED to APPROVED (no commit/push/deploy)
  cookvideo-agent complete [--commit <hash>]
                            Move a task's remaining lifecycle phases through to COMPLETED, only
                            when every remaining transition is valid per the lifecycle rules
                            (refuses from FAILED/BLOCKED/CANCELLED, and from approvalStatus
                            PENDING/REJECTED). Optionally records the CookVideo commit hash the
                            implementation was committed as. Never edits CookVideo, invokes
                            Claude, or runs git commit/push/deploy.
  cookvideo-agent reset     Reset task state to empty (does not delete source or repo files)
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
                            COMMITTING/DEPLOYING/VERIFYING. Never edits CookVideo, invokes
                            Claude, or runs git commit/push.
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
    case "approve": {
      const result = runApprove();
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
