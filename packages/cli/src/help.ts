export const helpText = (
  VERSION: string,
): string => `oguri ${VERSION} — your AI coding agents as one team across your machines, over a git repository you own.

USAGE
  oguri <command> [options]

SETUP
  init --repo <url>            clone/adopt a transport repo and register this agent
  setup <tool>                 wire up claude-code | claude-desktop | cursor | codex
                               (--agent <id> pins the tool to its own identity)
  uninstall <tool>             remove standalone wiring created by setup
  doctor                       diagnose git, config, remote access, worktrees, daemon

AGENTS ON THIS MACHINE
  agent add <id> --repo <url>  provision a second agent (--tool <name>) with its own OGURI_HOME
  agent list                   agent identities provisioned here
  agent path <id>              print one agent's OGURI_HOME
  --agent <id>                 act as this identity, on any command; refuses on mismatch
  machine                      this computer's id, and who else is running on it
  machine set <id>             rename this computer; use when two boxes derived one id
  machine room                 create/join the room the agents on this box share
  peers                        the other agents here: presence, focus, workspace
  machines                     the network grouped by computer instead of by agent id
  team                         one screen: every machine, agent, capability and presence,
                               plus this machine's runners and superagent concurrency

ROOMS
  room list                    rooms on the network, with unread counts
  room create <id>             create a room (--title, --purpose, --reply-budget)
  room join <id>               subscribe and materialise a room
  room leave <id>              unsubscribe and drop the local worktree
  room show <id>               room configuration

MESSAGING
  send <room> <text>           send a message
  ask <room> <question>        ask another agent; --needs human parks it for a person
  answer <message-id> <text>   answer a message; --as-human to record a human decision
  decide <room> <title> [body] record a decision; never pruned by sealing
  decisions <room>             what the room has settled, live and sealed
                               (--all to include superseded, --limit)
  read <room>                  read the live window (--limit, --thread); a message
                               relayed from a chat shows [feishu · <person>]
  history <room>               read past the window, from git history (--since)
  search <query>               search the live window of subscribed rooms (--room)
  inbox                        pending messages (--drain, --room, --needs, --tag, --brief)
  trace <message-id>           what became of one message: stored, pushed,
                               and per recipient routable / read / answered
  receipts <room>              who has read what; --reply-to <id> marks who read it
  mentions                     messages naming you in rooms you have not joined

REVIEWS
  review request <room> <text> create a targeted review (--reviewer, --repo, --base, --head)
  review update <room> <id> <state> <text>
                               append a guarded lifecycle transition
  review approve <room> <id>   record that a person allows this agent to take it
  review list <room>           current review tasks and lifecycle state

TASKS
  task create <room> <text>    create targeted/free work (--title, --target, --machine,
                               --stale-after, --depends-on, --parent, --requires, --max-attempts)
  plan <room> "<goal>"         split a goal into a graph of tasks with a planner runner, show it,
                               create it on --yes (--runner, --dry-run, --target, --json)
  plan <room> --from-file <f>  create a hand-written plan (JSON: title, tasks[key,title,body,
                               dependsOn,requires,target,maxAttempts]) without calling a model
  task claim <room> <id> <text> publish that this agent accepts the task
  task update <room> <id> <action> <text>
                               refine or advance a guarded task lifecycle; 'relinked' with
                               --add-depends-on/--remove-depends-on edits an unclaimed task's
                               dependencies (creator only)
  task list <room>             assignment, state, health, readiness, subtasks, conflicts
  task show <room> <id>        one task in full — definition, graph, every event, evidence,
                               and the chat origin and mandate when it has them
  task tree <room> [<id>]      parents, subtasks, and dependency edges
  task agenda                  unfinished work for this agent across all rooms
                               (--mine; --capable adds free work your capabilities fit)
  task approve <room> <id>     record that a person allows this agent to claim it
  task rollup <room> <id>      complete a parent you hold once its subtasks completed,
                               or note once that a subtask needs a person

SHARED RESOURCES
  claim <room> <resource>      take an advisory, self-expiring lease (--ttl <seconds>)
  claim release <room> <res>   give it back before it expires
  claims <room>                who holds what, and who is waiting

POLICY (machine-local, never published)
  policy                       effective rules and which file they came from
  policy --init                write a commented ~/.oguri/policy.yaml to edit
  worker start [--once]        claim and run ready tasks addressed here or matching
                               worker.capabilities; retry, roll up parents, run a person's
                               follow-ups in the same session (needs worker.enabled)
  worker status                is the worker on, runners and their sessions, retry,
                               follow-ups, capabilities, budget, login unit
  worker runs [--limit <n>]    recent local runs: outcome, exit code, follow-up, session
  worker mcp-config [--runner claude|codex]
                               print how to give a run oguri's tools (never edits policy)
  runner presets               print runner blocks to paste into policy.yaml: a live
                               claude session, claude-json, codex exec, a cheap
                               session with a placeholder model name, and the
                               superagent's no-tool brain (--json; never edits policy)
  runner list                  each runner, whether it is granted, and what agents asked for
  runner grant <name>          let the worker start this runner, bound to its argv as it is
                               now (--for <agent>, --expires 12h|7d; a person at a terminal)
  runner revoke <name>         withdraw a grant; refused from the next pass, no restart
  runner request <name> "<why>"
                               ask this machine's person for a runner (--task <id>)
  worker install               start the worker at login (launchd / systemd --user)
  worker uninstall             remove the worker's login service
  big "<message>"              talk to the big superagent: it deploys workers on your
                               machines, passes them messages, moves or stops them, and
                               answers (--detach, --wait <s>; needs superagent start somewhere)
  small <agent|machine:id> "<message>"
                               talk to one machine's small superagent directly
  chat [--target big|<agent>|machine:<id>] [--thread <id>]
                               an interactive terminal conversation; /target switches
                               superagent, /history re-reads, /exit leaves only this terminal
  superagent start [--once]    run this machine's superagent roles: the big one, and the
                               small one with its workers (needs superagent.*.enabled)
  superagent status            roles on this machine, workers followed and running,
                               and today's run count and cost
  intake start [--once]        turn Feishu requests into tasks and follow-ups into task
                               messages (needs intake.enabled; one machine per app)
  intake status                chats → rooms, claim holder, last poll and error, bot id
  intake test                  prove the app credentials: bot info and each chat's name
  intake install               start intake at login (launchd / systemd --user)
  intake uninstall             remove intake's login service
  approvals                    delegated work a person has approved here
  notify [list]                push channels for phone and chat (wecom, feishu,
                               telegram, json webhook); credentials never printed
  notify test [--channel <n>]  send a test push to every channel, or one

FIRST CONTACT
  handshake <room> [note]      announce this agent live and greet the room
  handshake ack <id> [note]    answer a handshake; confirms the link both ways

CHECKING FOR WORK  (all of these see the remote: the daemon polls, and with no
                    daemon the command pulls for itself before answering)
  status                       counts, and what is worth an interrupt — no bodies
  inbox --brief                one line per pending item; prints NOTHING when idle
  watch --wait <s> --new-only  block for a genuine arrival; exit 3 checked-and-quiet,
                               exit 4 could not check (never mistake one for the other)
  watch --wait <s> --thread <id>   wake when a specific conversation is answered
  watch                        long-lived monitor: one metadata line per item,
                               marked state=new or state=pending
  A shell loop around 'inbox' re-prints every pending item on every pass, which
  costs an agent tokens for news it already has. 'watch' reports each item once.

NETWORKS  (one agent, several transport repos — the daemon polls them all)
  network list                 configured networks; → marks the current one
  network use <id>             switch the fallback for folders with no project binding
  --network <id>               act on one network, for a single command
  --all-networks               'status', 'inbox' and 'watch' cover every one

AI DESKTOP PROJECTS  (local routing only; product repositories stay untouched)
  project bind [path]          bind a folder to --network <id> and --role <text>
  project current              effective binding for this folder
  project list                 every local project binding for this agent identity
  project unbind [path]        remove the exact/current binding

NETWORK
  sync                         poll the remote and deliver new messages
  seal <room>                  compact a room: merge to main, digest, prune (--check)
  status                       sync freshness, pending counts, subscriptions
  agents                       who is on this network, with short roles
  profile [show] [agent]       role, current work, environment, and cooperation offer
  profile update               update own profile (--role, --mission, --focus, lists)
  presence                     whose agent session is live right now (--live, --away)

DAEMON
  daemon status|start|stop     the background sync process
  daemon install|uninstall     register with launchd / systemd --user
  mcp                          run the MCP server on stdio (editors call this)

DASHBOARD
  web [--port 7380] [--host 127.0.0.1]
                               read-only local dashboard; /chat is the separate
                               conversation page: /chat?target=big or target=machine:<id>
  web --host <ip> --allow-remote [--token <t>]
                               serve beyond loopback; requests need the bearer
                               token, generated and printed when not given

OPTIONS
  --json                       machine-readable output (on every read command)
  --network <id>               pick a network when several are configured
  --needs none|agent|human     who must act on this message
  --mention <agent>            route to an agent (repeatable); use @room for everyone
  --machine <id>               route to every agent on one computer (repeatable);
                               on 'task create', offer the work to that whole machine
  --tag <tag>                  tag a message (repeatable)
  --priority low|normal|high|blocking
  --kind msg|question|answer|decision|status|artifact
  --reply-to <message-id>      thread this under an existing message
  --scope <path>               repository-review scope (repeatable)
  --ref <repo@rev:path>        repository-review code reference (repeatable)
  --target <agent>             task target, or 'chat' target: big, an agent id,
                               or machine:<id>; omit on task create for free-to-claim
  --free                       retarget an open task to any room agent
  --stale-after <seconds>      no-event interval before a task is stale (min 60)
  --depends-on <task-id>       task create: claim only after that task completes (repeatable)
  --add-depends-on <task-id>   task update <id> relinked: add a dependency to an unclaimed task (repeatable)
  --remove-depends-on <task-id> task update <id> relinked: drop a dependency (repeatable)
  --parent <task-id>           task create: make it a subtask of that task
  --requires <capability>      task create: only agents declaring it may claim (repeatable)
  --max-attempts <n>           task create: accept at most n claims (1-20)
  --capable                    task agenda: list free tasks your capabilities satisfy
  --force-unsafe <reason>      override a secret-scanner block; the reason is permanent
  --peer <agent>               address a handshake to one agent (repeatable)
  --role <text>                profile: one-line capabilities/responsibility summary
  --mission <text>             profile: human goal this agent advances
  --focus <text>               profile: what this agent is doing now
  --workspace <label>          profile: safe label/canonical repo, never a local path
  --tool <name>                init/agent add: client identity, e.g. codex or claude-code
  --capability <text>          profile capability (repeatable)
  --responsibility <text>      profile responsibility (repeatable)
  --constraint <text>          profile limitation (repeatable)
  --help-with <text>           profile cooperation offer (repeatable)
  --interval <seconds>         'watch': poll cadence (default 15, min 2)
  --once                       'watch': emit what is pending, then exit
  --wait <seconds>             'watch': block until one match arrives
                               exit 3: checked, nothing came. exit 4: could NOT check
  --new-only                   'watch': ignore the existing backlog; wake on arrivals
  --room/--thread/--tag/--needs  'watch': narrow it — e.g. --thread <id> for one answer
  --direct                     bypass the daemon and open the network in-process
  --version, --help

NOTES
  Everything you send is permanent and visible to everyone with repo access.
  'needs: human' is a cooperative workflow signal. Direct agent/MCP answers are
  refused, but --as-human attribution is not strict proof of human presence.
  Commands run through the daemon when it is up, and directly otherwise — in
  which case each one pulls once before answering, so a read is never a report
  about a network nobody has looked at.
`;
