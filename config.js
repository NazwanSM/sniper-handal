const SETTINGS = Object.freeze({
  profileDir: "./six-profile",

  // Satu request polling global setiap 5 detik. Dengan tiga target aktif,
  // masing-masing target diperiksa kira-kira setiap 15 detik.
  pollRequestIntervalMs: 3000,

  maxParallelPageLoads: 2,
  requestTimeoutMs: 15000,
  navigationTimeoutMs: 15000,
  elementTimeoutMs: 10000,
  htmlMountTimeoutMs: 5000,
});

const PLAN_URL =
  "https://six.itb.ac.id/app/mahasiswa:18223066+2026-1/registrasi/rencanastudi/2021084234";

// Gunakan sectionNumber untuk memilih nomor kelas yang tampil di kartu SIX.
// Aktifkan kembali target lain dengan menghapus tanda komentar pada objeknya.
const TARGETS = [
  // {
  //   courseCode: "PL4044",
  //   sectionNumber: "01",
  //   label: "PL4044 / kelas 01",
  //   url: "https://six.itb.ac.id/app/mahasiswa:18223066+2026-1/registrasI/mk/2021084234/kelas/49099?fakultas=SAPPK&prodi=154#49099",
  //   addSuccessPattern: /PL4044 berhasil ditambahkan/i,
  // },
  // {
  //   courseCode: "KU5005",
  //   sectionNumber: "01",
  //   label: "KU5005 / kelas 01",
  //   url: "https://six.itb.ac.id/app/mahasiswa:18223066+2026-1/registrasI/mk/2021084234/kelas/54594?fakultas=NONFS&prodi=179#54594",
  //   addSuccessPattern: /KU5005 berhasil ditambahkan/i,
  // },
  // {
  //   courseCode: "KU5010",
  //   sectionNumber: "01",
  //   label: "KU5010 / kelas 01",
  //   url: "https://six.itb.ac.id/app/mahasiswa:18223066+2026-1/registrasI/mk/2021084234/kelas/54592?fakultas=NONFS&prodi=179#54595",
  //   addSuccessPattern: /KU5010 berhasil ditambahkan/i,
  // },
  // {
  //   courseCode: "FK3057",
  //   sectionNumber: "02",
  //   label: "FK3057 / kelas 02",
  //   url: "https://six.itb.ac.id/app/mahasiswa:18223066+2026-1/registrasI/mk/2021084234/kelas/54320?fakultas=SF&prodi=116#54320",
  //   addSuccessPattern: /FK3057 berhasil ditambahkan/i,
  // },
  // {
  //   courseCode: "DK3014",
  //   sectionNumber: "02",
  //   label: "DK3014 / kelas 02",
  //   url: "https://six.itb.ac.id/app/mahasiswa:18223066+2026-1/registrasI/mk/2021084234/kelas/50713?fakultas=FSRD&prodi=174#50713",
  //   addSuccessPattern: /DK3014 berhasil ditambahkan/i,
  // },
  {
    courseCode: "ME4066",
    sectionNumber: "02",
    label: "ME4066 / kelas 02",
    url: "https://six.itb.ac.id/app/mahasiswa:18223066+2026-1/registrasI/mk/2021084234/kelas/51959?fakultas=FITB&prodi=128#51959",
    addSuccessPattern: /ME4066 berhasil ditambahkan/i,
  }
];

module.exports = { PLAN_URL, SETTINGS, TARGETS };
