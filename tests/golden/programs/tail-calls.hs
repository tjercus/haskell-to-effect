-- Tail calls compile to loops, so these run far deeper than the JS stack allows.
module Main where

sumTo :: Int -> Int -> Int
sumTo acc 0 = acc
sumTo acc n = sumTo (acc + n) (n - 1)

lastElem :: [a] -> a
lastElem [x] = x
lastElem (_:xs) = lastElem xs
lastElem [] = error "lastElem: empty list"

anyOf :: (a -> Bool) -> [a] -> Bool
anyOf _ [] = False
anyOf p (x:xs) = p x || anyOf p xs

collatzSteps :: Int -> Int
collatzSteps = go 0
  where
    go steps 1 = steps
    go steps n
      | n `mod` 2 == 0 = go (steps + 1) (n `div` 2)
      | otherwise = go (steps + 1) (3 * n + 1)

countDigits :: Int -> Int
countDigits n = loop n 1
  where
    loop m acc = case m `div` 10 of
      0 -> acc
      q -> loop q (acc + 1)

-- Each closure must keep the value of `n` from its own iteration.
adders :: Int -> [Int -> Int] -> [Int -> Int]
adders 0 acc = acc
adders n acc = adders (n - 1) ((\x -> x + n) : acc)

wait :: Int -> IO ()
wait 0 = putStrLn "done waiting"
wait n = wait (n - 1)

main :: IO ()
main = do
  print (sumTo 0 1000000)
  print (lastElem (replicate 200000 'x' ++ "y"))
  print (anyOf (> 99999) (replicate 100000 1 ++ [100000]), anyOf (< 0) [1, 2, 3])
  print (map collatzSteps [1, 6, 27])
  print (countDigits 1234567)
  print (map (\f -> f 100) (adders 3 []))
  let add = sumTo 0
  print (add 10, add 20)
  wait 100000
