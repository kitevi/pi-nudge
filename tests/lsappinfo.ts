/**
 * lsappinfo output for the macOS focus probe, laid out as macOS 27 prints it:
 * `lsappinfo front` answers with the frontmost application's ASN, and
 * `lsappinfo info <ASN>` with that application's record.
 */
export const FRONT_ASN = "ASN:0x0-0x41041:";

const record = (name: string, pid: number) =>
	[
		`"${name}" ${FRONT_ASN} (in front) `,
		'    bundleID="org.example.app"',
		'    bundle path="/Applications/Example.app"',
		'    executable path="/Applications/Example.app/Contents/MacOS/example"',
		`    pid = ${pid} token=[sess=100002 pid=${pid} uid:501,501,501 g:20,20 pV:4868] type="Foreground" flavor=3 Version="1.0" fileType="APPL" creator="????" Arch=ARM64 `,
		"    coalition: 1052",
		'    parentASN="Dock" ASN:0x0-0xd00d: ',
		"",
	].join("\n");

/** A readCommand for a Mac whose frontmost application is `front` and whose `ps -ax -o pid=,ppid=` prints `ps`. */
export const readMacCommand =
	(front: { name: string; pid: number }, ps: string | undefined) =>
	async (command: string, args: string[]): Promise<string | undefined> => {
		if (command === "ps") return ps;
		if (command !== "lsappinfo") return undefined;
		if (args[0] === "front") return `${FRONT_ASN}\n`;
		if (args[0] === "info" && args[1] === FRONT_ASN) return record(front.name, front.pid);
		return undefined;
	};
