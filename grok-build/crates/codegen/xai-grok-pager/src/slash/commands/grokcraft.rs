use crate::app::actions::Action;
use crate::slash::command::{CommandExecCtx, CommandResult, SlashCommand, slash_meta};

pub struct GrokcraftCommand;

impl SlashCommand for GrokcraftCommand {
    slash_meta! {
        name: "grokcraft",
        description: "Connect this computer to Grokcraft WebUI",
        usage: "/grokcraft",
    }

    fn run(&self, _ctx: &mut CommandExecCtx, _args: &str) -> CommandResult {
        CommandResult::Action(Action::GrokcraftConnect)
    }
}
