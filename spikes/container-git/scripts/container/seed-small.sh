# Creates a tiny Node project and pushes it to the empty parent repo. No credential is in the container.
set -e
N=https://$H/git/gitflare-spike-c-ns
git config --global user.name spike; git config --global user.email spike@example.invalid
rm -rf /work/seed; mkdir -p /work/seed && cd /work/seed && git init -q -b main
cat > package.json <<'J'
{ "name": "tiny", "version": "1.0.0", "type": "module", "scripts": { "test": "node --test" }, "dependencies": { "left-pad": "1.3.0" } }
J
mkdir -p src test
printf 'export function add(a, b) {\n  return a + b;\n}\n' > src/math.js
printf 'export function greet(name) {\n  return "hello " + name;\n}\n\nexport function shout(name) {\n  return greet(name).toUpperCase();\n}\n' > src/greet.js
printf 'import test from "node:test";\nimport assert from "node:assert";\nimport { add } from "../src/math.js";\ntest("add", () => assert.equal(add(1, 2), 3));\n' > test/math.test.js
git add -A && git commit -q -m "initial"
git remote add origin $N/gitflare-spike-c-small.git
echo "remote: $(git remote get-url origin)"
set +e
git push -u origin main 2>&1; echo "push exit=$?"
git ls-remote origin 2>&1; echo "ls-remote exit=$?"
grep -ci 'art_v1\|authorization\|extraheader' .git/config || echo "no credential in .git/config"
env | grep -ci 'art_v1' || echo "no token in env"
