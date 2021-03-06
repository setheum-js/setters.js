# Setheum EVM Examples

ETHDenver Workshop Link: https://www.crowdcast.io/e/setheum-ethdenver-2021

This workshop is for learning to use Setheum EVM. It demonstrates how to deploy a simple ERC20 contract, a complex project like Uniswap, and use the on-chain scheduler function to build a recurring payment DApp.

Read more about Setheum EVM [here](https://wiki.setheum.network/learn/basics/setheum-evm)
Developer Guide [here](https://wiki.setheum.network/build/development-guide/smart-contracts/get-started-evm)

## Run
install all dependencies
```
rush update
```

compile and build all contracts
```
./run.sh build    # only rebuild if source file changed
./run.sh rebuild  # force rebuild all
```

run all tests
```
./run.sh test
```

build and run together
```
./run.sh run
```

or we can run tests for a single example:
- cd into one of the example project
  - You can find your contract ABI in the build directory. You can upload these ABI files to [setheum evm playground](https://evm.setheum.network/#/upload) for testing.
  - Run the tests with `rushx test`.

## Development
update dep package version for all examples
```
rush add -p <package> --all
```

update dep package version for a single example
```
cd <project>
rush add -p <package>
```

### Tips and Docs
- `rushx` is an alternative to `yarn`, so we can also use `yarn test` instead of `rushx test`.
- The test cases are written with with [ethers.js](https://docs.ethers.io/v5/) and [waffle](https://ethereum-waffle.readthedocs.io/en/latest/).
