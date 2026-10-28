//! peers: an inbox messenger between OpenCode, Claude Code and Antigravity
//! agent sessions on this machine. See `peers --help`.

mod address;
mod channel;
mod cli;
mod deliver;
mod identity;
mod presence;
mod runtime;
mod store;
mod util;

fn main() {
    let args = <cli::Cli as clap::Parser>::parse();
    if let Err(e) = cli::run(args) {
        eprintln!("peers: error: {e}");
        std::process::exit(2);
    }
}
