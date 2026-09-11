# Fresh installed-skill attempt

This record separates one fresh attempt from the later corrective work.

- Brief: implement `example/dynamic-hero` and `example/resource-list` in the
  neutral consumer, after reading the installed Block Runner skill; custom PHP
  and editor behaviour were required, and `realize()` had to supply the list's
  native introduction. It was explicitly forbidden to read another worktree,
  use Docker, commit or push.
- Skill identity: `.agents/skills/block-runner/.block-runner-install.json`,
  package version `0.9.3`, installed from this exact source revision.
- Model and effort: unknown. The execution receipt did not prove them, so this
  record does not infer them from the requested agent role.
- First delivery: seven added files; the exact unmodified delivered diff is
  retained in `skill-attempt-first-delivery.diff`.
- First-delivery outcome: incomplete. It chose the correct continuation route
  and assembled/parsing native introduction, but did not provide an installable
  consumer registration/build, used a different hero attribute contract, and
  omitted parts of the requested custom behaviour.
- Intervention: the lead replaced that incomplete consumer with the ordinary
  registered plugin source in this directory, added the build/reproduction
  instructions and prepared the runtime proof. Runtime success therefore is
  evidence for the corrected implementation, not an unassisted skill pass.

The first attempt did not silently substitute a generated static shell or stop
at an unsupported automatic integration boundary. One attempt is not a
reliability score.
