# GateX language

GateX is a bounded, declarative state-machine language. The parser is shared by TinyApproval, AgentApproval, and edited workspace sources.

## Grammar

The accepted grammar is the following EBNF. Whitespace and `//` comments are ignored.

```ebnf
machine          = "machine", identifier, "{", declaration*, "}" ;
declaration      = states | state | inputs | input | outputs | output
                  | terminal | initial | reset | reset_on | transition | emission ;
states           = "states", name_list, ";" ;
state            = "state", identifier, ["terminal"], ";" ;
inputs           = "inputs", name_list, ";" ;
input            = "input", identifier, ";" ;
outputs          = "outputs", name_list, ";" ;
output           = "output", identifier, ";" ;
terminal         = "terminal", name_list, ";" ;
initial          = "initial", identifier, ";" ;
reset            = "reset", identifier, ";" ;
reset_on         = "reset_on", identifier, ";" ;
transition       = ["transition"], identifier, "->", identifier,
                   "when", expression, ["emit", name_list], ";" ;
emission         = "emit", identifier, "=", expression, ";" ;
name_list        = identifier, {",", identifier} ;
expression       = or_expression ;
or_expression    = and_expression, {"||", and_expression} ;
and_expression   = unary_expression, {"&&", unary_expression} ;
unary_expression = ["!"], primary ;
primary          = identifier | "true" | "false"
                  | "(", expression, ")"
                  | "state", "==", identifier ;
identifier       = letter, {letter | digit | "_"} ;
```

The optional `transition` keyword supports the compact transition spelling used by the locked AgentApproval example. The explicit `transition` spelling is also valid. `reset_on` declares global reset semantics. `reset` is the explicit-reset form used by TinyApproval, where reset behavior is represented by ordinary transitions.

## Semantics and limits

- States, inputs, and outputs have separate declarations and may not reuse a name across namespaces.
- The initial state must be declared. All declared states must be reachable from it.
- The compiler accepts at most 8 states, 8 inputs, and 4 outputs.
- Every state and every encoded input assignment must select exactly one transition.
- Ambiguous and uncovered transition rows are validation errors.
- Terminal states self-loop while reset is inactive.
- `reset_on cancel` gives `cancel` priority over ordinary transitions, returns to the initial state, clears transition-pulse outputs, and rejects `cancel` in ordinary guards.
- Outputs are pulses computed from the old state, current inputs, and selected transition. They are not persistent flags and do not depend on the returned next state.
- Invalid encoded state bits recover to the initial state with cleared outputs.
- State and input bit packing is deterministic and least-significant-bit first.
- A rule may declare up to four outputs. The compiler emits the output gates last, in declaration order, which is how the netlist reads them.

## Example

```text
machine AgentApproval {
  states IDLE, REQUESTED, APPROVED, USED;
  initial IDLE;
  inputs request, approve, execute, cancel, human_ok, scope_ok;
  outputs permit;
  terminal USED;
  reset_on cancel;

  IDLE -> REQUESTED when request;
  REQUESTED -> APPROVED when approve && human_ok && scope_ok;
  APPROVED -> USED when execute && human_ok && scope_ok emit permit;
}
```

The example is compiled through the generic parser and compiler path. AgentApproval is a flagship example, not a separate language.

## Diagnostics

The compiler reports source locations for lexical and parse errors. Validation diagnostics identify duplicate names, unknown symbols, invalid initial or reset declarations, missing transitions, ambiguous rows, unreachable states, invalid terminal behavior, and limit violations. A valid edited source remains available for local compilation and simulation, but it is stale for any manufactured-circuit binding unless its exact accepted artifact identity matches.
