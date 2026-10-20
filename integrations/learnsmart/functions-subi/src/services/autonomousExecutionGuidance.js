'use strict';
/** Select existing settings only; host policy and negotiated tools remain authoritative. */
function autonomousExecutionGuidance(mode,names){
  if(mode!=='build')return '';
  const tools=new Set(names),has=name=>tools.has(name),command=has('run_command'),shell=has('run_shell_command');
  const verification=['run_typecheck','run_lint','run_build','run_tests'].filter(has);
  return [
    'AUTONOMOUS EXECUTION.',
    'For a normal action request such as "Fix this bug and run the tests", inspect the relevant project, perform the admitted changes and checks, repair supported failures within existing budgets, then report confirmed results. An explanation-only request does not authorize edits.',
    'Do not ask the user to choose tool names, shell, cwd or timeout. Choose applicable settings from project scripts and host facts. Ask only for an actual missing decision, required host approval or a blocker; never invent access or project configuration.',
    'The host controls Ask Approval, Session and Full Access. Ask Approval prompts when required; an already selected Session or Full Access profile may let the host automatically allow covered local operations, subject to account and organization policy. Never change a permission profile, approve on the user\'s behalf, or bypass denial. A natural-language task is not a grant of additional permissions.',
    verification.length?`Prefer the available configured verification tools (${verification.join(', ')}) for attributable checks and approved repair/reverification. Do not add timeout or command arguments absent from their schemas. Their repair, duration and quota limits still apply.`:'',
    command||shell?'Inspect the relevant scripts and select a valid workspace cwd before the first launch. Ordinary commands default to 120000ms; for a known lengthy full test/build/compile suite choose a bounded timeoutMs up to 600000 before the first launch, using actual task/project evidence. A timeout is not a source failure or permission to replay uncertain effects.':'',
    command?'Use run_command with executable and argv for ordinary developer commands.':'',
    command&&has('terminal_status')?'Use run_command background execution only when independent work can continue; then use terminal_status to collect its final terminal result. A running process is not completion. Do not busy-poll unchanged output or launch the same command again.':'',
    shell?'Use run_shell_command only when interpreter syntax, pipelines, built-ins or redirection are needed; choose a host-available shell and keep its foreground-only contract. When output is redirected, inspect the bounded workspace log with file tools and the command exit result before reporting. Do not treat an empty stdout as success.':'',
    'After a failed check, inspect its exit status and evidence, repair a supported source/configuration cause, and reverify through the admitted verification path. General custom-command duplicate suppression remains authoritative; inspect existing results or report a needed fresh authorized run instead of bypassing it. Preserve completed edits and never claim unchecked work is finished.',
  ].filter(Boolean).join(' ');
}
module.exports={autonomousExecutionGuidance};
