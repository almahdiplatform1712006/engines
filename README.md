# Engines

A teacher's own book (a PDF or photos) goes in. Questions and explanation come out, each filed under the teacher's own syllabus tree. Customers use it through its own page or the `/v1/` API.

- Spec: [issue #1](https://github.com/almahdiplatform1712006/engines/issues/1)
- Hard rules, layout and how to run it: [`AGENTS.md`](AGENTS.md)

```sh
npm install
npm test
docker compose up --build   # then: curl localhost:8080/v1/health
```
