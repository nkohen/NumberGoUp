# Legacy Rust prototype (archived)

This folder holds the **original CLI prototype** of Number Go Up (a text-based
Rust program). It is kept for reference only and is **not** part of the current
game, which is the web-native TypeScript app in the repository root.

Why it was set aside (not deleted): it captures the original data model and turn
ideas, and documents where the project started. The rationale for moving to a
TypeScript + Canvas stack is in [`../docs/DESIGN.md`](../docs/DESIGN.md#1-technology-stack)
and is raised as an open question in [`../QUESTIONS.md`](../QUESTIONS.md) (Q1).

To run the old prototype:

```bash
cd legacy-rust
cargo run
```

Note its rules differ slightly from the current game (it used a discard-pile
reshuffle and had no rounds, upgrades, or GUI).
