{ pkgs ? import <nixpkgs> { } }:

pkgs.mkShell {
  nativeBuildInputs = with pkgs; [
    cmake
    emscripten
    git
    ninja
    nodejs
    pkg-config
    zlib
    zlib.static
  ];
}
