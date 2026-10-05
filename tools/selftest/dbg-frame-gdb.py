"""Run under GDB's embedded Python; input supplied by dbg-frame-gdb-oracle.mjs."""
import gdb
import json
import os


def scalar_fields(value, path="", depth=0):
    if depth > 4:
        raise RuntimeError("oracle type nesting limit")
    typ = value.type.strip_typedefs()
    if typ.code == gdb.TYPE_CODE_ARRAY:
        lo, hi = typ.range()
        if hi - lo + 1 > 16:
            raise RuntimeError("oracle array limit")
        out = []
        for i in range(lo, hi + 1):
            out += scalar_fields(value[i], path + "[" + str(i) + "]", depth + 1)
        return out
    if typ.code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
        out = []
        for field in typ.fields():
            if not field.name:
                raise RuntimeError("anonymous oracle member")
            out += scalar_fields(value[field], (path + "." if path else "") + field.name, depth + 1)
        return out
    if typ.code not in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_ENUM, gdb.TYPE_CODE_PTR, gdb.TYPE_CODE_BOOL):
        raise RuntimeError("unsupported oracle scalar " + str(typ))
    return [{"path": path, "value": str(int(value))}]


def variables(frame):
    blocks = []
    block = frame.block()
    while block is not None and not block.is_global and not block.is_static:
        blocks.append(block)
        block = block.superblock
    result, occurrences = [], {}
    # Outer first matches lexical DIE traversal; do not collapse shadowed variables.
    for block in reversed(blocks):
        for symbol in block:
            if not (symbol.is_argument or symbol.is_variable):
                continue
            name = symbol.name
            occurrence = occurrences.get(name, 0)
            occurrences[name] = occurrence + 1
            item = {"name": name, "occurrence": occurrence, "argument": bool(symbol.is_argument), "status": "ok", "fields": []}
            try:
                value = frame.read_var(symbol)
                if value.is_optimized_out:
                    item["status"] = "unavailable"
                    item["reason"] = "optimized out"
                else:
                    item["fields"] = scalar_fields(value)
                    if value.address is not None:
                        item["address"] = int(value.address)
            except gdb.error as error:
                item["status"] = "unavailable"
                item["reason"] = str(error)
            result.append(item)
    return result


def capture():
    frames = []
    frame = gdb.newest_frame()
    for _ in range(32):
        if frame is None:
            break
        name = frame.name() or ""
        if not name.startswith("engine_frame_"):
            break
        frames.append({"name": name, "pc": int(frame.pc()) & ~1,
                       "sp": int(frame.read_register("sp")), "variables": variables(frame)})
        frame = frame.older()
    return frames


def main():
    with open(os.environ["AKALINK_GDB_FRAME_CONFIG"], encoding="utf-8") as source:
        config = json.load(source)
    result = {"schema": 1, "board": config["board"], "build": config["build"],
              "elfSha256": config["elfSha256"], "tool": "gdb " + gdb.VERSION,
              "codeVerified": False, "cases": {}}
    try:
        gdb.execute("set pagination off")
        gdb.execute("set confirm off")
        gdb.execute("set remotetimeout 15")
        gdb.execute("set tcp connect-timeout 15")
        gdb.execute("target extended-remote " + config["remote"])
        gdb.execute("monitor reset halt")
        if config["board"] == "f103ze":
            vector = bytes(gdb.selected_inferior().read_memory(0x08000000, 8))
            gdb.execute("monitor mww 0xe000ed08 0x08000000")
            gdb.execute("set $sp = " + str(int.from_bytes(vector[:4], "little")))
            gdb.execute("set $pc = " + str(int.from_bytes(vector[4:], "little") & ~1))
            gdb.execute("set $primask = 0")
            gdb.execute("set $faultmask = 0")
        inferior = gdb.selected_inferior()
        for section in config["code"]:
            expected = bytes.fromhex(section["hex"])
            for offset in range(0, len(expected), 4096):
                chunk = expected[offset:offset + 4096]
                actual = bytes(inferior.read_memory(section["addr"] + offset, len(chunk)))
                if actual != chunk:
                    raise RuntimeError("target code differs from ELF: " + section["name"])
        result["codeVerified"] = True
        for case in config["cases"]:
            bp = gdb.Breakpoint("*" + str(case["address"]), type=gdb.BP_HARDWARE_BREAKPOINT, internal=True)
            try:
                gdb.execute("continue")
                pc = int(gdb.parse_and_eval("$pc")) & ~1
                if pc != case["address"]:
                    raise RuntimeError("stopped outside checkpoint " + case["id"])
                result["cases"][case["id"]] = {"pc": pc, "frames": capture()}
            finally:
                bp.delete()
        # Detach releases the GDB client; stop the GDB server before WebUSB claims the probe.
        gdb.execute("detach")
        with open(config["out"], "w", encoding="utf-8") as output:
            json.dump(result, output, indent=2)
    except Exception as error:
        gdb.write("FRAME_ORACLE_ERROR: " + str(error) + "\n", gdb.STDERR)
        try:
            gdb.execute("disconnect")
        except gdb.error:
            pass
        gdb.execute("quit 1")

main()
