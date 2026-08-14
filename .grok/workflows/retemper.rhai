let meta = #{
    name: "retemper",
    description: "Plan, accept, build, harden, review, QA, and open a PR — no skipped gates after Development",
    when_to_use: "When a task should go through architect grilling, acceptance tests, TDD development, cleanup, testing, review, final QA, and pipeline monitoring, replaying every later phase after a return to Development",
    phases: [
        #{ title: "Planning", detail: "architect + grill-me (grill even if a plan exists)" },
        #{ title: "Acceptance tests", detail: "user-facing definition of done" },
        #{ title: "Development", detail: "TDD, Clean Code, SOLID / KISS / YAGNI / DRY" },
        #{ title: "Cleaner", detail: "same behaviour, cleaner design" },
        #{ title: "Testing", detail: "manual gaps; automate what was missed" },
        #{ title: "Code review", detail: "diff review; missing tests are blockers" },
        #{ title: "Final QA Review", detail: "boot, re-run acceptance, try to break it" },
        #{ title: "Pipeline monitoring", detail: "open PR; pause until CI is actually done" },
        #{ title: "Standards", detail: "living CODING_STANDARDS.md unless turned off" },
    ],
};

const MAX_CYCLES = 3;

let verdict_schema = #{
    "type": "object", "required": ["return_to_dev", "reason", "evidence"],
    "properties": #{
        "return_to_dev": #{ "type": "boolean" },
        "reason": #{ "type": "string" },
        "evidence": #{ "type": "string" },
        "summary": #{ "type": "string" },
        "needs_user": #{ "type": "boolean" },
        "merged": #{ "type": "boolean" },
    },
};

let plan_schema = #{
    "type": "object", "required": ["summary", "grill_open"],
    "properties": #{
        "summary": #{ "type": "string" },
        "grill_open": #{ "type": "boolean" },
        "questions": #{ "type": "string" },
    },
};

fn trimmed(s) {
    if type_of(s) == "string" {
        s.trim();
        s
    } else {
        ""
    }
}

fn is_map(x) { type_of(x) == "map" }

fn contains_text(hay, needle) {
    if type_of(hay) != "string" || type_of(needle) != "string" { return false; }
    if needle.len() == 0 { return true; }
    if hay.len() < needle.len() { return false; }
    let i = 0;
    while i + needle.len() <= hay.len() {
        if hay.sub_string(i, needle.len()) == needle { return true; }
        i += 1;
    }
    false
}

fn take_after(hay, flag) {
    let padded = " " + hay + " ";
    let needle = " " + flag + " ";
    let i = 0;
    while i + needle.len() <= padded.len() {
        if padded.sub_string(i, needle.len()) == needle {
            let rest = padded.sub_string(i + needle.len(), padded.len() - (i + needle.len()));
            rest.trim();
            let end = 0;
            while end < rest.len() && rest.sub_string(end, 1) != " " { end += 1; }
            return rest.sub_string(0, end);
        }
        i += 1;
    }
    ""
}

fn strip_flags(line) {
    let out = "";
    let token = "";
    let skip_next = false;
    let padded = line + " ";
    let i = 0;
    while i < padded.len() {
        let ch = padded.sub_string(i, 1);
        if ch == " " {
            if token != "" {
                if skip_next {
                    skip_next = false;
                } else if token == "--no-grill" || token == "--no-grill-me" || token == "--no-plan" || token == "--no-standards" {
                } else if token == "--ticket" || token == "--plan" {
                    skip_next = true;
                } else if contains_text(token, "--ticket=") || contains_text(token, "--plan=") {
                } else if !contains_text(token, "--") {
                    if out != "" { out += " "; }
                    out += token;
                }
                token = "";
            }
        } else {
            token += ch;
        }
        i += 1;
    }
    out
}

fn empty_bag() {
    #{ task: "", plan: "", ticket: "", focus: "", no_plan: false, grill: true, update_standards: true }
}

fn normalize_args(raw) {
    let bag = empty_bag();
    if raw == () { return bag; }
    if type_of(raw) == "string" {
        let line = trimmed(raw);
        bag.task = strip_flags(line);
        if contains_text(line, "--no-grill") || contains_text(line, "--no-grill-me") { bag.grill = false; }
        if contains_text(line, "--no-plan") { bag.no_plan = true; }
        if contains_text(line, "--no-standards") { bag.update_standards = false; }
        let ticket = take_after(line, "--ticket");
        if ticket != "" { bag.ticket = ticket; }
        let plan = take_after(line, "--plan");
        if plan != "" { bag.plan = plan; }
        return bag;
    }
    if !is_map(raw) { return bag; }
    bag.task = trimmed(raw.task);
    bag.plan = trimmed(raw.plan);
    bag.ticket = trimmed(raw.ticket);
    bag.focus = trimmed(raw.focus);
    if raw.no_plan == true { bag.no_plan = true; }
    if raw.grill == false || raw.grill_me == false || raw.no_grill == true || raw.no_grill_me == true {
        bag.grill = false;
    }
    if raw.update_standards == false || raw.living_standards == false || raw.no_standards == true {
        bag.update_standards = false;
    }
    bag
}

fn arg_text(bag, key) {
    if !is_map(bag) { return ""; }
    if key == "task" { return trimmed(bag.task); }
    if key == "plan" { return trimmed(bag.plan); }
    if key == "ticket" { return trimmed(bag.ticket); }
    if key == "focus" { return trimmed(bag.focus); }
    ""
}

fn want_no_plan(bag) {
    is_map(bag) && bag.no_plan == true
}

fn want_grill(bag) {
    is_map(bag) && bag.grill != false
}

fn want_standards(bag) {
    is_map(bag) && bag.update_standards != false
}

fn has_brief(bag) {
    arg_text(bag, "plan") != "" || arg_text(bag, "ticket") != ""
}

fn skip_planning(bag) {
    want_no_plan(bag) && has_brief(bag) && !want_grill(bag)
}

fn should_return(res) {
    if res == () || !res.success { return true; }
    if !is_map(res.output) { return true; }
    if res.output.return_to_dev != true { return false; }
    trimmed(res.output.evidence) != ""
}

fn needs_human(res) {
    res != () && res.success && is_map(res.output) && res.output.needs_user == true
}

fn was_merged(res) {
    res != () && res.success && is_map(res.output) && res.output.merged == true
}

fn role_prefix(role_file) {
    let text = "This repo may have CODING_STANDARDS.md at the root — read it if it exists; ignore it if it does not. ";
    text += "If references/" + role_file + " exists, or .grok/retemper/references/" + role_file;
    text += " exists, or a user-level retemper/references/" + role_file;
    text += " exists, read it and follow it. Stay language- and stack-agnostic. ";
    text += "Use the project's own tools and layout. Do not require Jira, NX, or a particular UI toolkit. ";
    text
}

fn task_blob(bag) {
    let text = " Task: " + json_encode(arg_text(bag, "task")) + ".";
    if arg_text(bag, "ticket") != "" { text += " Ticket: " + json_encode(arg_text(bag, "ticket")) + "."; }
    if arg_text(bag, "plan") != "" { text += " Existing plan: " + json_encode(arg_text(bag, "plan")) + "."; }
    if arg_text(bag, "focus") != "" { text += " Focus: " + json_encode(arg_text(bag, "focus")) + "."; }
    text
}

let bag = normalize_args(args);
let task = arg_text(bag, "task");
if task == "" {
    pause("verification", "Say what to ship. Easiest: /workflow retemper Add CSV export   — or JSON {\"task\":\"Add CSV export\"}. Optional flags: --no-grill --no-plan --ticket ID --no-standards");
}
if want_no_plan(bag) && !has_brief(bag) {
    pause("verification", "When skipping a new plan (--no-plan / no_plan), pass a ticket or an existing plan.");
}

let brief_json = json_encode(#{
    task: arg_text(bag, "task"),
    plan: arg_text(bag, "plan"),
    ticket: arg_text(bag, "ticket"),
    focus: arg_text(bag, "focus"),
    no_plan: want_no_plan(bag),
    grill: want_grill(bag),
    update_standards: want_standards(bag),
});

// --- Planning -------------------------------------------------------------
phase("Planning");
let plan_summary = "";
if skip_planning(bag) {
    log("Planning skipped (no_plan + brief + --no-grill)");
    plan_summary = arg_text(bag, "plan");
    if plan_summary == "" { plan_summary = "Ticket " + arg_text(bag, "ticket"); }
} else {
    let p_prompt = role_prefix("architect.md");
    p_prompt += "You are the Architect. Modular, domain-driven, hexagonal / plug-in shape. ";
    p_prompt += "Small coherent packages, not a monolith of huge horizontal layers. ";
    p_prompt += "Use read-only tools first (read_file, grep, list_dir). Look up facts. ";
    p_prompt += "Do not implement. ";
    if want_no_plan(bag) && has_brief(bag) {
        p_prompt += "A plan or ticket already exists — do not replace it. Refine only if grilling uncovers a hole. ";
        plan_summary = arg_text(bag, "plan");
        if plan_summary == "" { plan_summary = "Ticket " + arg_text(bag, "ticket"); }
    } else {
        p_prompt += "Write a plan an independent developer can follow. ";
    }
    if want_grill(bag) {
        p_prompt += "Run a grilling interview (Matt Pocock grill-me / grilling) even though a brief may already exist. ";
        p_prompt += "Design tree, frontier questions, recommended answers. Decisions for the user, facts for you. ";
        p_prompt += "If a grilling or grill-me skill file exists, read it and follow it. ";
        p_prompt += "Set grill_open=true if any decision is still the user's. ";
    } else {
        p_prompt += "Grilling is turned off (--no-grill). Do not interview. Set grill_open=false. ";
    }
    p_prompt += task_blob(bag);
    p_prompt += " Brief JSON: " + brief_json + ".";

    let plan_res = agent(p_prompt, #{
        label: "architect",
        capability_mode: "read-only",
        output_schema: plan_schema,
    });

    if plan_res != () && plan_res.success && is_map(plan_res.output) {
        if trimmed(plan_res.output.summary) != "" { plan_summary = trimmed(plan_res.output.summary); }
        if want_grill(bag) && plan_res.output.grill_open == true {
            let q = trimmed(plan_res.output.questions);
            let msg = "Planning grill is open. Answer the frontier questions, then resume.";
            if q != "" { msg += " " + q; }
            await_user("user", msg);
        }
    } else if want_grill(bag) {
        await_user("user", "Architect did not return a usable plan. Confirm or paste a plan, then resume.");
    }
    if plan_summary == "" { plan_summary = arg_text(bag, "task"); }
}

let plan_json = json_encode(plan_summary);

// --- Acceptance tests -----------------------------------------------------
phase("Acceptance tests");
let acc_prompt = role_prefix("qa-acceptance.md");
acc_prompt += "You are the QA engineer who writes acceptance tests. ";
acc_prompt += "If every acceptance test passes, the task is done from the user's point of view. ";
acc_prompt += "Author high-level end-to-end scenarios (and executable tests in this repo's convention). ";
acc_prompt += "Cover happy path, empty/error states, and user-visible quality. ";
acc_prompt += "Do not write unit tests of internals. Do not implement the feature. ";
acc_prompt += task_blob(bag) + " Plan: " + plan_json + ".";
acc_prompt += " Set return_to_dev=false. evidence must list the files you wrote.";

let acc_res = agent(acc_prompt, #{
    label: "acceptance",
    capability_mode: "all",
    output_schema: verdict_schema,
});
let acc_note = "acceptance tests authored";
if acc_res != () && acc_res.success && is_map(acc_res.output) {
    acc_note = trimmed(acc_res.output.summary);
    if acc_note == "" { acc_note = trimmed(acc_res.output.evidence); }
}

// --- Hardening loop -------------------------------------------------------
let cycle = 1;
let finished = false;
let stopped = false;
let last_reason = "";
let bounce_from = "";

while cycle <= MAX_CYCLES && !finished && !stopped {
    log("Cycle " + cycle.to_string() + "/" + MAX_CYCLES.to_string());
    let bounce = false;

    phase("Development");
    let d_prompt = role_prefix("developer.md");
    d_prompt += "You are the Developer. Top priority: TDD. Then Clean Code / Clean Coder. ";
    d_prompt += "SOLID, KISS, YAGNI, DRY. Small well-named methods, not comments. Code as a poem. ";
    d_prompt += "Test behaviour, never implementation. Write the failing test first. ";
    d_prompt += "Implement only this task. Make the acceptance tests reachable and passing. ";
    d_prompt += "Clear dependencies. Reuse existing modules. No spaghetti. ";
    d_prompt += task_blob(bag) + " Plan: " + plan_json + ".";
    d_prompt += " Acceptance note: " + json_encode(acc_note) + ".";
    if bounce_from != "" {
        d_prompt += " You are fixing a return from " + bounce_from + ": " + json_encode(last_reason) + ".";
    }
    d_prompt += " Set return_to_dev=false unless you are physically blocked. evidence = what you changed.";
    let dev_res = agent(d_prompt, #{
        label: "developer:" + cycle.to_string(),
        capability_mode: "all",
        output_schema: verdict_schema,
    });
    if dev_res != () && dev_res.success && is_map(dev_res.output) {
        if trimmed(dev_res.output.summary) != "" { last_reason = trimmed(dev_res.output.summary); }
    }

    if !bounce {
        phase("Cleaner");
        let c_prompt = role_prefix("cleaner.md");
        c_prompt += "You are the Cleaner. Same behaviour, cleaner design. ";
        c_prompt += "Remove duplication, dead dependencies, smells. Run existing tests. ";
        c_prompt += "If the feature is wrong — not merely messy — set return_to_dev=true with evidence. ";
        c_prompt += "Otherwise refactor in place and set return_to_dev=false. ";
        c_prompt += task_blob(bag);
        let cl_res = agent(c_prompt, #{
            label: "cleaner:" + cycle.to_string(),
            capability_mode: "all",
            output_schema: verdict_schema,
        });
        if should_return(cl_res) {
            bounce = true;
            bounce_from = "Cleaner";
            if cl_res != () && is_map(cl_res.output) { last_reason = trimmed(cl_res.output.reason) + " " + trimmed(cl_res.output.evidence); }
            else { last_reason = "Cleaner returned no usable verdict"; }
        }
    }

    if !bounce {
        phase("Testing");
        let t_prompt = role_prefix("tester.md");
        t_prompt += "You are the hands-on tester. Find what TDD and acceptance tests missed. ";
        t_prompt += "If a gap should have been automated, add the test. Missing tests are blockers. ";
        t_prompt += "If tests fail or quality is too poor, set return_to_dev=true with evidence. ";
        t_prompt += "If you only add passing coverage or document a truly manual step, return_to_dev=false. ";
        t_prompt += task_blob(bag);
        let te_res = agent(t_prompt, #{
            label: "tester:" + cycle.to_string(),
            capability_mode: "all",
            output_schema: verdict_schema,
        });
        if should_return(te_res) {
            bounce = true;
            bounce_from = "Testing";
            if te_res != () && is_map(te_res.output) { last_reason = trimmed(te_res.output.reason) + " " + trimmed(te_res.output.evidence); }
            else { last_reason = "Testing returned no usable verdict"; }
        }
    }

    if !bounce {
        phase("Code review");
        let r_prompt = role_prefix("reviewer.md");
        r_prompt += "You are the Reviewer. Read the real diff (git diff / the files). Do not review from memory. ";
        r_prompt += "Correctness, design, tests, security. Missing tests are blockers. ";
        r_prompt += "Set return_to_dev=true only with evidence you inspected. Suggest concrete patches. ";
        r_prompt += task_blob(bag);
        let rv_res = agent(r_prompt, #{
            label: "reviewer:" + cycle.to_string(),
            capability_mode: "read-only",
            output_schema: verdict_schema,
        });
        if should_return(rv_res) {
            bounce = true;
            bounce_from = "Code review";
            if rv_res != () && is_map(rv_res.output) { last_reason = trimmed(rv_res.output.reason) + " " + trimmed(rv_res.output.evidence); }
            else { last_reason = "Code review returned no usable verdict"; }
        }
    }

    if !bounce {
        phase("Final QA Review");
        let q_prompt = role_prefix("final-qa.md");
        q_prompt += "You are Final QA — a skeptic of the claim that this task is done. ";
        q_prompt += "Do not trust earlier phase summaries. Build and start what this repo actually ships. ";
        q_prompt += "Re-run the acceptance tests yourself. Try to refute: hunt gaps and edge cases. ";
        q_prompt += "If you find a gap, set return_to_dev=true with evidence. Do not fix the product here. ";
        q_prompt += "If acceptance passes and you cannot break it, return_to_dev=false. ";
        q_prompt += "Do not pretend you booted something you could not. Unrun checks are not approval. ";
        q_prompt += task_blob(bag);
        let qa_res = agent(q_prompt, #{
            label: "final-qa:" + cycle.to_string(),
            capability_mode: "all",
            output_schema: verdict_schema,
        });
        if should_return(qa_res) {
            bounce = true;
            bounce_from = "Final QA Review";
            if qa_res != () && is_map(qa_res.output) { last_reason = trimmed(qa_res.output.reason) + " " + trimmed(qa_res.output.evidence); }
            else { last_reason = "Final QA returned no usable verdict"; }
        }
    }

    if !bounce {
        phase("Pipeline monitoring");
        let i_prompt = role_prefix("pipeline.md");
        i_prompt += "Final QA approved. Open a pull request (or this repo's equivalent). ";
        i_prompt += "If a pipeline exists, use its real status. Merge only on a real green signal. ";
        i_prompt += "If CI failed because of code, set return_to_dev=true with the first real error. ";
        i_prompt += "If there is no pipeline, or CI is still running (15-minute jobs are normal), set needs_user=true and do not merge. ";
        i_prompt += "The workflow will pause; the human resumes it when CI is done. That is how we wait — do not busy-loop. ";
        i_prompt += "Never invent a green build. ";
        i_prompt += task_blob(bag);
        let pi_res = agent(i_prompt, #{
            label: "pipeline:" + cycle.to_string(),
            capability_mode: "all",
            output_schema: verdict_schema,
        });
        if should_return(pi_res) {
            bounce = true;
            bounce_from = "Pipeline monitoring";
            if pi_res != () && is_map(pi_res.output) { last_reason = trimmed(pi_res.output.reason) + " " + trimmed(pi_res.output.evidence); }
            else { last_reason = "Pipeline returned no usable verdict"; }
        } else if needs_human(pi_res) {
            await_user("user", "CI is missing or still running (often 10–20 minutes). When it finishes, run /workflow resume retemper — or say that it failed.");
            let pi2 = agent(i_prompt + " The user resumed after a CI gate. Re-check status and merge only if green.", #{
                label: "pipeline-recheck:" + cycle.to_string(),
                capability_mode: "all",
                output_schema: verdict_schema,
            });
            if should_return(pi2) {
                bounce = true;
                bounce_from = "Pipeline monitoring";
                if pi2 != () && is_map(pi2.output) { last_reason = trimmed(pi2.output.reason) + " " + trimmed(pi2.output.evidence); }
                else { last_reason = "Pipeline recheck returned no usable verdict"; }
            } else {
                finished = true;
                if was_merged(pi2) { last_reason = "merged after resume"; }
                else { last_reason = "pipeline finished after resume"; }
            }
        } else {
            finished = true;
            if was_merged(pi_res) { last_reason = "merged"; }
            else { last_reason = "pipeline finished"; }
        }
    }

    if bounce {
        cycle += 1;
        if cycle > MAX_CYCLES {
            stopped = true;
            last_reason = "max-cycles after return from " + bounce_from;
        } else {
            log("Returning to Development; replaying every later phase (from " + bounce_from + ")");
        }
    }
}

phase("Standards");
if finished && want_standards(bag) {
    let s_prompt = role_prefix("standards.md");
    s_prompt += "CODING_STANDARDS.md is a living document. Update it with conventions this run actually established. ";
    s_prompt += "Create it if missing. Keep it short. Do not invent a stack the repo does not use. ";
    s_prompt += "If nothing new was learned, leave the file alone and say so. ";
    s_prompt += task_blob(bag);
    let st_res = agent(s_prompt, #{
        label: "standards",
        capability_mode: "all",
        output_schema: verdict_schema,
    });
    if st_res != () && st_res.success && is_map(st_res.output) && trimmed(st_res.output.summary) != "" {
        last_reason = last_reason + " | standards: " + trimmed(st_res.output.summary);
    }
} else if !want_standards(bag) {
    log("CODING_STANDARDS.md left untouched (--no-standards / update_standards=false)");
} else {
    log("Standards skipped because the run did not finish cleanly");
}

let status = "complete";
if stopped { status = "stopped"; }
let report = "# Retemper\n\n";
report += "Task: " + arg_text(bag, "task") + "\n\n";
report += "Status: **" + status + "** (" + last_reason + ")\n\n";
report += "Cycles used: " + cycle.to_string() + " / " + MAX_CYCLES.to_string() + "\n\n";
report += "Planning: " + plan_summary + "\n\n";
report += "Acceptance: " + acc_note + "\n";
let report_path = write_scratch_file("report.md", report);
complete(#{
    path: report_path,
    report: report,
    status: status,
    cycles: cycle,
    reason: last_reason,
});
